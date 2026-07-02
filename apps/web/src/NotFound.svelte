<script lang="ts">
  // 404 surface (Commit 2). Thin wrapper over ErrorPage: an unknown hash route
  // ("page") or a document slug that doesn't exist / the API 404s ("doc"). Both
  // offer a way back home rather than a raw error or blank screen.
  import ErrorPage from "./ErrorPage.svelte";
  import { t } from "./i18n/index.svelte";

  let { kind = "page" }: { kind?: "page" | "doc" } = $props();
</script>

<ErrorPage
  title={kind === "doc" ? t("error.docNotFoundTitle") : t("error.notFoundTitle")}
  message={kind === "doc" ? t("error.docNotFoundBody") : t("error.notFoundBody")}
  action="home"
/>
