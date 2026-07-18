// 404 surface. Thin wrapper over ErrorPage: an unknown hash route ("page") or
// a document slug that doesn't exist / the API 404s ("doc"). Both offer a way
// back home rather than a raw error or blank screen. React port of the web
// NotFound.svelte.
import { useT } from "@/state/i18n";
import { ErrorPage } from "./ErrorPage";

interface Props {
  kind?: "page" | "doc";
}

export function NotFound({ kind = "page" }: Props) {
  const t = useT();

  return (
    <ErrorPage
      title={kind === "doc" ? t("error.docNotFoundTitle") : t("error.notFoundTitle")}
      message={kind === "doc" ? t("error.docNotFoundBody") : t("error.notFoundBody")}
      action="home"
    />
  );
}

export default NotFound;
