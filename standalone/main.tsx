import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TodoPage } from "../components/TodoPage";
import TodoHeaderActions from "../components/TodoHeaderActions";
import { Icon } from "../components/ui/icon";
import { Button } from "../components/ui/button";
import { useConnection } from "./runtime";

const params = new URLSearchParams(window.location.search);
const initialTheme = params.get("theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.classList.toggle("dark", initialTheme === "dark");
if ((window as Window & { bbDesktop?: { platform?: string } }).bbDesktop?.platform === "macos") {
  document.documentElement.classList.add("native-macos");
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (this.state.error) return <div className="boot-message" role="alert">
      <p>Cannot show Todo. Keep BB open and reload this tab.</p>
      <Button onClick={() => window.location.reload()}>Reload Todo</Button>
    </div>;
    return this.props.children;
  }
}

function App() {
  const [subPath, setSubPath] = useState(params.get("list") ?? "");
  const [dark, setDark] = useState(initialTheme === "dark");
  const connection = useConnection();
  useEffect(() => {
    const changed = () => setSubPath(new URLSearchParams(window.location.search).get("list") ?? "");
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    const url = new URL(window.location.href);
    url.searchParams.set("theme", next ? "dark" : "light");
    window.history.replaceState(null, "", url);
  }
  return <>
    <header className="standalone-header">
      <div className="flex items-center gap-2"><Icon name="ListTodo" className="size-5" /><h1>Todo</h1></div>
      <div className="flex items-center gap-2">
        {connection === "reconnecting" && <span role="status" className="text-xs text-muted-foreground">Reconnect to BB…</span>}
        <TodoHeaderActions standalone />
        <Button variant="ghost" size="icon" aria-label={dark ? "Use light theme" : "Use dark theme"} onClick={toggleTheme}>
          <Icon name={dark ? "Idea" : "LightbulbOff"} />
        </Button>
      </div>
    </header>
    <main className="standalone-board"><TodoPage subPath={subPath} /></main>
    <Toaster richColors theme={dark ? "dark" : "light"} />
  </>;
}

createRoot(document.getElementById("root")!).render(<ErrorBoundary><App /></ErrorBoundary>);
