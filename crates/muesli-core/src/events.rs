//! The workspace structure-change event (Plan 4 Contract 1), broadcast on the per-workspace
//! SSE stream and consumed by the muesli-cli sync daemon. `slug` is a document's immutable
//! room id; `id` is a folder uuid carried as a String so the wire form needs no uuid feature.

use serde::{Deserialize, Serialize};

/// A structural change in a workspace.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceEvent {
    FolderCreated {
        id: String,
        parent_id: Option<String>,
        name: String,
    },
    FolderRenamed {
        id: String,
        name: String,
    },
    FolderMoved {
        id: String,
        parent_id: Option<String>,
    },
    FolderDeleted {
        id: String,
    },
    DocCreated {
        slug: String,
        folder_id: Option<String>,
        title: Option<String>,
    },
    DocRenamed {
        slug: String,
        title: Option<String>,
    },
    DocMoved {
        slug: String,
        folder_id: Option<String>,
    },
    DocDeleted {
        slug: String,
    },
    /// Content wake-ping: doc `slug` received a CRDT update. Not structural; wakes a cold
    /// session to pull. Coalesced by the consumer.
    DocUpdated {
        slug: String,
    },
}

/// SSE payload: the event plus the client-id that caused it (echo-guard). None = UI/unknown.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEventEnvelope {
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(flatten)]
    pub event: WorkspaceEvent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_created_round_trips() {
        let ev = WorkspaceEvent::FolderCreated {
            id: "f1".into(),
            parent_id: Some("root".into()),
            name: "Projects".into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["kind"], "folder_created");
        assert_eq!(json["id"], "f1");
        assert_eq!(json["parent_id"], "root");
        assert_eq!(json["name"], "Projects");
        let back: WorkspaceEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn every_variant_tag_is_snake_case() {
        let cases = [
            (
                WorkspaceEvent::FolderRenamed {
                    id: "f".into(),
                    name: "n".into(),
                },
                "folder_renamed",
            ),
            (
                WorkspaceEvent::FolderMoved {
                    id: "f".into(),
                    parent_id: None,
                },
                "folder_moved",
            ),
            (
                WorkspaceEvent::FolderDeleted { id: "f".into() },
                "folder_deleted",
            ),
            (
                WorkspaceEvent::DocCreated {
                    slug: "s".into(),
                    folder_id: None,
                    title: None,
                },
                "doc_created",
            ),
            (
                WorkspaceEvent::DocRenamed {
                    slug: "s".into(),
                    title: Some("T".into()),
                },
                "doc_renamed",
            ),
            (
                WorkspaceEvent::DocMoved {
                    slug: "s".into(),
                    folder_id: Some("f".into()),
                },
                "doc_moved",
            ),
            (
                WorkspaceEvent::DocDeleted { slug: "s".into() },
                "doc_deleted",
            ),
            (
                WorkspaceEvent::DocUpdated { slug: "s".into() },
                "doc_updated",
            ),
        ];
        for (ev, tag) in cases {
            let json = serde_json::to_value(&ev).unwrap();
            assert_eq!(json["kind"], tag, "wrong tag for {ev:?}");
            let back: WorkspaceEvent = serde_json::from_value(json).unwrap();
            assert_eq!(back, ev);
        }
    }

    #[test]
    fn envelope_flattens_to_one_object() {
        // The exact wire form from Contract 1.
        let env = WorkspaceEventEnvelope {
            origin: Some("client-abc".into()),
            event: WorkspaceEvent::DocRenamed {
                slug: "notes".into(),
                title: Some("Notes".into()),
            },
        };
        let s = serde_json::to_string(&env).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["origin"], "client-abc");
        assert_eq!(v["kind"], "doc_renamed");
        assert_eq!(v["slug"], "notes");
        assert_eq!(v["title"], "Notes");
        // `event` is flattened: there must be no nested "event" key.
        assert!(v.get("event").is_none());
        let back: WorkspaceEventEnvelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back, env);
    }

    #[test]
    fn envelope_origin_defaults_to_none() {
        // A daemon-less producer (room DocUpdated) omits origin; consumers parse it back.
        let wire = r#"{"kind":"doc_updated","slug":"notes"}"#;
        let env: WorkspaceEventEnvelope = serde_json::from_str(wire).unwrap();
        assert_eq!(env.origin, None);
        assert_eq!(
            env.event,
            WorkspaceEvent::DocUpdated {
                slug: "notes".into()
            }
        );
    }
}
