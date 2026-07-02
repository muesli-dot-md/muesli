//! Notifications platform (sub-project ④c). A generic, pluggable delivery layer whose v1
//! event type is the @mention. Three moving parts:
//!
//! - **Channels** ([`NotificationChannel`]): where a notification is delivered. v1 ships
//!   `in_app` (delivery is the `notification` row the inbox reads) and `email`. BOTH are
//!   toggleable per user — disabling both for an event mutes it entirely. `slack`/others are a
//!   future addition: implement the trait and add it to the dispatcher's channel set; nothing
//!   else changes.
//! - **Preferences**: a per-user *event-type × channel* matrix (table `notification_preference`),
//!   resolved against coded defaults by the pure [`resolve_channels`]. Both in-app and email
//!   default ON for mentions (opt-out); a stored `enabled=false` disables either independently.
//! - **Email transport** ([`EmailSender`]): a swappable sink. The dev impl
//!   ([`ConsoleEmailSender`]) logs to console and is what runs in tests; the prod impl
//!   ([`SmtpEmailSender`]) is provider-agnostic SMTP via env-configured creds (SES / Postmark /
//!   Resend — the provider is a config choice, not fixed here).
//!
//! The [`Dispatcher`] ties them together: given a freshly-created notification it resolves the
//! recipient's enabled channels for that event type and delivers to each. Delivery is spawned
//! off the request path (see `api::record_body_mentions`) so a comment create never blocks on
//! email.
//!
//! NOT BUILT (explicit later hardening, per the spec): a durable queue, retries, and
//! delivery-layer idempotency. Enqueue idempotency rides on the ④b mention unique constraint
//! (migration 0013) — a re-derived mention inserts no second `notification` row because the
//! caller only enqueues for newly-inserted mentions.

use std::sync::Arc;

use serde::Serialize;
use uuid::Uuid;

/// The only event type v1 emits. The schema (and this module) stay generic for future types.
pub const EVENT_MENTION: &str = "mention";

/// Channel identifiers (stored verbatim in `notification_preference.channel`).
pub const CHANNEL_IN_APP: &str = "in_app";
pub const CHANNEL_EMAIL: &str = "email";

/// The channels v1 knows about. In-app is first (the inbox row) and email second. Both are
/// toggleable. Adding `slack` later = add a const + an arm here + a `NotificationChannel`
/// impl; [`resolve_channels`] and the dispatcher pick it up generically.
pub const ALL_CHANNELS: &[&str] = &[CHANNEL_IN_APP, CHANNEL_EMAIL];

/// The coded default for a (event_type, channel) when the user has no explicit preference row.
///
/// - in-app defaults ON for mentions (the inbox is the product surface) — but it is toggleable,
///   so an explicit stored `enabled=false` disables it.
/// - email defaults ON for mentions (opt-out, matching Quip / Google "email me when mentioned").
/// - everything else defaults OFF.
pub fn default_enabled(event_type: &str, channel: &str) -> bool {
    match channel {
        CHANNEL_IN_APP => true,
        CHANNEL_EMAIL => event_type == EVENT_MENTION,
        _ => false,
    }
}

/// Whether a channel can be turned off at all. Every v1 channel (in-app and email) is
/// toggleable: a stored `enabled=false` disables it via [`resolve_channels`]. This stays a
/// function so a future structural always-on channel could opt out.
pub fn channel_is_toggleable(_channel: &str) -> bool {
    true
}

/// One stored preference row, as the matrix read returns it.
#[derive(Debug, Clone, Serialize)]
pub struct PreferenceRow {
    pub event_type: String,
    pub channel: String,
    pub enabled: bool,
}

/// Resolve the channels a notification of `event_type` should deliver to, honoring the user's
/// stored `prefs` over the coded [`default_enabled`]. Pure — the dispatcher's testable core.
///
/// Rules (every channel is treated the same, in-app included):
/// - A stored row for the (event_type, channel) wins; absent → the coded default.
/// - in-app defaults on (so the inbox row is created unless explicitly disabled); email defaults
///   on for mentions. Disabling both mutes the event entirely.
///
/// Returned in [`ALL_CHANNELS`] order so delivery order is deterministic.
pub fn resolve_channels(event_type: &str, prefs: &[PreferenceRow]) -> Vec<String> {
    ALL_CHANNELS
        .iter()
        .filter(|&&channel| {
            match prefs
                .iter()
                .find(|p| p.event_type == event_type && p.channel == channel)
            {
                Some(p) => p.enabled,
                None => default_enabled(event_type, channel),
            }
        })
        .map(|&c| c.to_string())
        .collect()
}

/// A notification with everything a channel needs to deliver it, resolved once up front so the
/// channels don't re-query. `recipient_email` is None for users without an email on file (the
/// email channel then no-ops). `doc_url` is the canonical webapp deep-link.
#[derive(Debug, Clone)]
pub struct RenderedNotification {
    pub event_type: String,
    pub recipient_id: Uuid,
    pub recipient_email: Option<String>,
    pub actor_name: String,
    pub doc_title: String,
    pub doc_url: String,
}

/// The webapp deep-link to a document's thread (canonical surface — desktop deep-linking is a
/// later nicety, per the spec). `web_origin` is the server's configured MUESLI_WEB_ORIGIN.
pub fn doc_deep_link(web_origin: &str, doc_slug: &str) -> String {
    // The slug is untrusted input: percent-encode it (same encoder the storage backends
    // use) so reserved characters can never break out of the path/fragment of the link
    // that lands in a recipient's inbox.
    format!(
        "{}/#/doc/{}",
        web_origin.trim_end_matches('/'),
        crate::storage::uri_encode(doc_slug, true)
    )
}

/// Neutralize an untrusted display string (actor name, doc title) for the email subject:
/// strip control characters (including CR/LF) and cap the length. lettre's typed header
/// encoding already prevents CRLF header injection; this is defense-in-depth plus display
/// hygiene against attacker-chosen names/titles (finding 2).
fn subject_field(s: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max_chars + 4));
    for (n, c) in s.chars().filter(|c| !c.is_control()).enumerate() {
        if n == max_chars {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

/// Render the v1 mention email: subject + plaintext body. Pure (the `EmailSender` dev impl is
/// asserted against this exact output in tests).
pub fn render_mention_email(n: &RenderedNotification) -> (String, String) {
    let subject = format!(
        "{} mentioned you in «{}»",
        subject_field(&n.actor_name, 80),
        subject_field(&n.doc_title, 120),
    );
    let body = format!(
        "{actor} mentioned you in «{doc}».\n\nOpen it: {url}\n",
        actor = n.actor_name,
        doc = n.doc_title,
        url = n.doc_url,
    );
    (subject, body)
}

// ---------------------------------------------------------------------------
// Email transport: a swappable sink.
// ---------------------------------------------------------------------------

/// A boxed, `Send` future — keeps [`EmailSender`] dyn-compatible so the dispatcher can hold an
/// `Arc<dyn EmailSender>` chosen at startup (console vs SMTP) without going generic.
pub type SendFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + 'a>>;

/// A pluggable email transport. The dev impl logs to console (and runs in tests); the prod
/// impl is provider-agnostic SMTP. Callers depend on this trait, never a concrete provider.
/// Dyn-compatible (boxed future) so it can be selected at runtime and stored behind `Arc`.
pub trait EmailSender: Send + Sync {
    /// Deliver one message. Errors are surfaced to the caller (the email channel logs and
    /// swallows them — a failed email must never crash a delivery task).
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> SendFuture<'a>;
}

/// Dev / test email sink: records nothing remotely, logs the rendered message to the tracing
/// console. In tests it also captures the last message sent for assertions.
#[derive(Default)]
pub struct ConsoleEmailSender {
    #[cfg(test)]
    pub sent: std::sync::Mutex<Vec<(String, String, String)>>,
}

impl EmailSender for ConsoleEmailSender {
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> SendFuture<'a> {
        Box::pin(async move {
            tracing::info!(%to, %subject, "email (console transport)\n{body}");
            #[cfg(test)]
            self.sent
                .lock()
                .unwrap()
                .push((to.into(), subject.into(), body.into()));
            Ok(())
        })
    }
}

/// SMTP config read from the environment (the prod seam). All five must be present for the
/// SMTP sender to build; otherwise the server falls back to the console sender.
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// The From: address (e.g. "muesli <no-reply@example.com>").
    pub from: String,
}

impl SmtpConfig {
    /// Read MUESLI_SMTP_HOST / _PORT / _USERNAME / _PASSWORD / _FROM. None when host is unset
    /// (email then runs on the console transport — the documented dev default).
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("MUESLI_SMTP_HOST").ok()?;
        Some(SmtpConfig {
            host,
            port: std::env::var("MUESLI_SMTP_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(587),
            username: std::env::var("MUESLI_SMTP_USERNAME").unwrap_or_default(),
            password: std::env::var("MUESLI_SMTP_PASSWORD").unwrap_or_default(),
            from: std::env::var("MUESLI_SMTP_FROM")
                .unwrap_or_else(|_| "muesli <no-reply@muesli.local>".into()),
        })
    }
}

/// Provider-agnostic SMTP sender (the prod transport). Wired but not exercised in CI — there
/// is no live SMTP server in tests; [`ConsoleEmailSender`] is what runs there.
pub struct SmtpEmailSender {
    transport: lettre::AsyncSmtpTransport<lettre::Tokio1Executor>,
    from: lettre::message::Mailbox,
}

impl SmtpEmailSender {
    pub fn new(cfg: SmtpConfig) -> anyhow::Result<Self> {
        use lettre::transport::smtp::authentication::Credentials;
        let creds = Credentials::new(cfg.username, cfg.password);
        let transport = lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&cfg.host)?
            .port(cfg.port)
            .credentials(creds)
            .build();
        let from = cfg.from.parse()?;
        Ok(Self { transport, from })
    }
}

impl EmailSender for SmtpEmailSender {
    fn send<'a>(&'a self, to: &'a str, subject: &'a str, body: &'a str) -> SendFuture<'a> {
        Box::pin(async move {
            use lettre::AsyncTransport;
            let email = lettre::Message::builder()
                .from(self.from.clone())
                .to(to.parse()?)
                .subject(subject)
                .body(body.to_string())?;
            self.transport.send(email).await?;
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Channels.
// ---------------------------------------------------------------------------

/// A delivery channel. The seam for slack/others: implement this and add the channel id to
/// [`ALL_CHANNELS`] + the dispatcher's channel map. The in-app channel is implicit (the
/// `notification` row is its delivery), so only out-of-band channels (email, …) impl this.
pub trait NotificationChannel: Send + Sync {
    /// The channel id (matches `notification_preference.channel`). Part of the seam: a channel
    /// registry keyed by this lands when a second out-of-band channel (slack) is added.
    #[allow(dead_code)]
    fn id(&self) -> &'static str;
    fn deliver(&self, n: &RenderedNotification) -> impl std::future::Future<Output = ()> + Send;
}

/// The email channel: renders the mention email and hands it to the [`EmailSender`]. A missing
/// recipient email or a transport error is logged and swallowed — delivery is best-effort.
pub struct EmailChannel {
    pub sender: Arc<dyn EmailSender>,
}

impl NotificationChannel for EmailChannel {
    fn id(&self) -> &'static str {
        CHANNEL_EMAIL
    }
    async fn deliver(&self, n: &RenderedNotification) {
        let Some(to) = n.recipient_email.as_deref() else {
            tracing::debug!(recipient = %n.recipient_id, "email channel: recipient has no email; skipping");
            return;
        };
        let (subject, body) = render_mention_email(n);
        if let Err(e) = self.sender.send(to, &subject, &body).await {
            tracing::warn!(%e, %to, "email channel: send failed");
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

/// Resolves a notification's enabled channels and delivers to each out-of-band channel. The
/// in-app channel needs no delivery (its row already exists), so the dispatcher only fans out
/// to email today. Holds the email channel directly; a channel registry replaces this when a
/// second out-of-band channel lands.
pub struct Dispatcher {
    email: EmailChannel,
}

impl Dispatcher {
    pub fn new(sender: Arc<dyn EmailSender>) -> Self {
        Self {
            email: EmailChannel { sender },
        }
    }

    /// Deliver `n` to every enabled out-of-band channel resolved from `prefs`. In-app (when
    /// resolved on) is a no-op here — its delivery is the persisted `notification` row written
    /// at enqueue time. Email delivers only when [`resolve_channels`] includes it.
    pub async fn dispatch(&self, n: &RenderedNotification, prefs: &[PreferenceRow]) {
        let channels = resolve_channels(&n.event_type, prefs);
        for channel in channels {
            match channel.as_str() {
                CHANNEL_IN_APP => {} // delivery is the persisted notification row
                CHANNEL_EMAIL => self.email.deliver(n).await,
                other => tracing::warn!(channel = other, "dispatcher: unknown channel, skipping"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pref(event: &str, channel: &str, enabled: bool) -> PreferenceRow {
        PreferenceRow {
            event_type: event.into(),
            channel: channel.into(),
            enabled,
        }
    }

    fn sample(email: Option<&str>) -> RenderedNotification {
        RenderedNotification {
            event_type: EVENT_MENTION.into(),
            recipient_id: Uuid::nil(),
            recipient_email: email.map(String::from),
            actor_name: "Ada".into(),
            doc_title: "Design Notes".into(),
            doc_url: "http://localhost:5173/#/doc/design-notes".into(),
        }
    }

    #[test]
    fn defaults_in_app_always_on_email_on_for_mentions() {
        assert!(default_enabled(EVENT_MENTION, CHANNEL_IN_APP));
        assert!(default_enabled(EVENT_MENTION, CHANNEL_EMAIL));
        assert!(default_enabled("comment_reply", CHANNEL_IN_APP));
        // email defaults OFF for non-mention event types in v1.
        assert!(!default_enabled("comment_reply", CHANNEL_EMAIL));
        assert!(!default_enabled(EVENT_MENTION, "slack"));
    }

    #[test]
    fn resolve_uses_defaults_when_no_prefs() {
        // No stored prefs → in-app + email (the mention default).
        assert_eq!(
            resolve_channels(EVENT_MENTION, &[]),
            vec![CHANNEL_IN_APP, CHANNEL_EMAIL]
        );
    }

    #[test]
    fn resolve_honors_disabled_email() {
        let prefs = vec![pref(EVENT_MENTION, CHANNEL_EMAIL, false)];
        // email opted out → only in-app remains.
        assert_eq!(
            resolve_channels(EVENT_MENTION, &prefs),
            vec![CHANNEL_IN_APP]
        );
    }

    #[test]
    fn in_app_is_toggleable() {
        // in-app can now be turned off per channel (default stays on).
        assert!(channel_is_toggleable(CHANNEL_IN_APP));
        assert!(channel_is_toggleable(CHANNEL_EMAIL));
    }

    #[test]
    fn resolve_keeps_in_app_on_by_default() {
        // No stored in-app row → in-app is on (the opt-out default).
        assert!(resolve_channels(EVENT_MENTION, &[])
            .iter()
            .any(|c| c == CHANNEL_IN_APP));
    }

    #[test]
    fn resolve_honors_disabled_in_app() {
        // A stored enabled=false for in-app now disables it (no longer forced on).
        let prefs = vec![pref(EVENT_MENTION, CHANNEL_IN_APP, false)];
        let channels = resolve_channels(EVENT_MENTION, &prefs);
        assert!(
            !channels.iter().any(|c| c == CHANNEL_IN_APP),
            "in-app opted out → not present"
        );
        // email is independent and stays on (its mention default).
        assert!(
            channels.iter().any(|c| c == CHANNEL_EMAIL),
            "email unaffected by in-app toggle"
        );
    }

    #[test]
    fn resolve_in_app_and_email_are_independent() {
        // in-app off but email on.
        let only_email = vec![pref(EVENT_MENTION, CHANNEL_IN_APP, false)];
        assert_eq!(
            resolve_channels(EVENT_MENTION, &only_email),
            vec![CHANNEL_EMAIL]
        );
        // email off but in-app on.
        let only_in_app = vec![pref(EVENT_MENTION, CHANNEL_EMAIL, false)];
        assert_eq!(
            resolve_channels(EVENT_MENTION, &only_in_app),
            vec![CHANNEL_IN_APP]
        );
        // both off → fully muted.
        let neither = vec![
            pref(EVENT_MENTION, CHANNEL_IN_APP, false),
            pref(EVENT_MENTION, CHANNEL_EMAIL, false),
        ];
        assert!(
            resolve_channels(EVENT_MENTION, &neither).is_empty(),
            "both off → no channels"
        );
    }

    #[test]
    fn resolve_honors_explicit_email_enable_for_non_default_type() {
        // A future type that defaults email OFF but the user opted IN.
        let prefs = vec![pref("comment_reply", CHANNEL_EMAIL, true)];
        assert_eq!(
            resolve_channels("comment_reply", &prefs),
            vec![CHANNEL_IN_APP, CHANNEL_EMAIL]
        );
    }

    #[test]
    fn renders_mention_email_with_actor_doc_and_link() {
        let n = sample(Some("ada@example.com"));
        let (subject, body) = render_mention_email(&n);
        assert_eq!(subject, "Ada mentioned you in «Design Notes»");
        assert!(body.contains("Ada mentioned you in «Design Notes»"));
        assert!(body.contains("http://localhost:5173/#/doc/design-notes"));
    }

    #[test]
    fn deep_link_targets_the_webapp_doc_url() {
        assert_eq!(
            doc_deep_link("http://localhost:5173", "design-notes"),
            "http://localhost:5173/#/doc/design-notes"
        );
        // trailing slash on the origin is normalized.
        assert_eq!(
            doc_deep_link("https://app.muesli.dev/", "x"),
            "https://app.muesli.dev/#/doc/x"
        );
    }

    #[test]
    fn deep_link_percent_encodes_untrusted_slugs() {
        assert_eq!(
            doc_deep_link("http://localhost:5173", "a/b?c#d e"),
            "http://localhost:5173/#/doc/a%2Fb%3Fc%23d%20e"
        );
    }

    #[test]
    fn subject_field_strips_control_chars_and_caps_length() {
        // CR/LF and other control chars are removed, printable text kept verbatim.
        assert_eq!(subject_field("Ada\r\nBcc: x\u{7}", 80), "AdaBcc: x");
        assert_eq!(subject_field("Design Notes", 120), "Design Notes");
        // Over-long input is capped with an ellipsis, on a char boundary.
        let capped = subject_field(&"é".repeat(100), 80);
        assert_eq!(capped.chars().count(), 81);
        assert!(capped.ends_with('…'));
    }

    #[tokio::test]
    async fn dispatcher_emails_when_enabled_and_invokes_sender_with_rendered_content() {
        let sender = Arc::new(ConsoleEmailSender::default());
        let dispatcher = Dispatcher::new(sender.clone() as Arc<dyn EmailSender>);
        let n = sample(Some("ada@example.com"));
        // default prefs → email on.
        dispatcher.dispatch(&n, &[]).await;
        let sent = sender.sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "exactly one email delivered");
        let (to, subject, body) = &sent[0];
        assert_eq!(to, "ada@example.com");
        assert_eq!(subject, "Ada mentioned you in «Design Notes»");
        assert!(body.contains("http://localhost:5173/#/doc/design-notes"));
    }

    #[tokio::test]
    async fn dispatcher_skips_email_when_disabled() {
        let sender = Arc::new(ConsoleEmailSender::default());
        let dispatcher = Dispatcher::new(sender.clone() as Arc<dyn EmailSender>);
        let n = sample(Some("ada@example.com"));
        let prefs = vec![pref(EVENT_MENTION, CHANNEL_EMAIL, false)];
        dispatcher.dispatch(&n, &prefs).await;
        assert!(
            sender.sent.lock().unwrap().is_empty(),
            "email opted out → no send"
        );
    }

    #[tokio::test]
    async fn dispatcher_skips_email_when_recipient_has_no_address() {
        let sender = Arc::new(ConsoleEmailSender::default());
        let dispatcher = Dispatcher::new(sender.clone() as Arc<dyn EmailSender>);
        let n = sample(None); // no email on file
        dispatcher.dispatch(&n, &[]).await;
        assert!(
            sender.sent.lock().unwrap().is_empty(),
            "no address → no send"
        );
    }
}
