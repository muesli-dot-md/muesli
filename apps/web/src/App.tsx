import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

/**
 * Scaffold placeholder — replaced by the Stage-2 feature wave (router shell,
 * Home, DocApp, SettingsPage). Exercises a few shadcn primitives so the ui/
 * copies are compiled from day one, on the app-shell/canvas surface system.
 */
export default function App() {
  return (
    <div className="flex h-screen items-center justify-center bg-app-shell p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <span className="wordmark text-2xl">muesli</span> Web
          </CardTitle>
          <CardDescription>React 19 scaffold — feature wave pending.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Spinner className="size-4" />
          <Button variant="outline" size="sm" disabled>
            Coming together
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
