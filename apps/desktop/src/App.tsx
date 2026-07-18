import AppShell from "@/components/shell/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  return (
    <TooltipProvider delay={500}>
      <AppShell />
      <Toaster />
    </TooltipProvider>
  );
}
