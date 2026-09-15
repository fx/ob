import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Separator,
} from "@fx/ui";
import { Container, Github, Plug, RefreshCw, Search } from "lucide-react";
import { CommandBlock } from "./components/CommandBlock";
import { ThemeToggle } from "./components/ThemeToggle";

const REPOSITORY = "https://github.com/fx/ob";

const RUN_COMMAND = `docker run -p 3000:3000 -v ob-data:/data -e OBSIDIAN_AUTH_TOKEN=… -e VAULTS_JSON='[{"name":"vault"}]' ghcr.io/fx/ob:latest`;

const MCP_CONFIG = `{
  "mcpServers": {
    "ob": {
      "type": "http",
      "url": "http://<host>:3000/mcp"
    }
  }
}`;

const FEATURES = [
  {
    icon: RefreshCw,
    title: "Sync",
    body: "Runs the official Obsidian Sync client, bidirectionally. If sync stalls, it restarts itself.",
  },
  {
    icon: Search,
    title: "Search",
    body: "Hybrid vector and full-text search over your Markdown, in natural language.",
  },
  {
    icon: Plug,
    title: "REST and MCP",
    body: "The same file and search operations on both, with per-agent folder scoping on MCP.",
  },
  {
    icon: Container,
    title: "One container",
    body: "One process, one image, one volume. Nothing to orchestrate.",
  },
];

export function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-6">
          <span className="text-lg font-semibold tracking-tight">
            <span className="text-muted-foreground">$ </span>ob
          </span>
          <Badge variant="outline" className="hidden sm:inline-flex">
            MIT
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="GitHub repository"
              nativeButton={false}
              render={<a href={REPOSITORY} />}
            >
              <Github className="size-4" />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6">
        <section className="py-20 sm:py-28">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            Obsidian vaults, for agents.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            <span className="text-foreground">ob</span> keeps your Obsidian
            vaults synced, indexes them for natural-language search, and serves
            them over REST and MCP, from a single container.
          </p>

          <div className="mt-10 max-w-xl">
            <CommandBlock commands={[RUN_COMMAND]} label="Run" />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              nativeButton={false}
              render={<a href={`${REPOSITORY}#readme`} />}
            >
              Read the docs
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href={`${REPOSITORY}#configuration`} />}
            >
              Configuration
            </Button>
          </div>
        </section>

        <Separator />

        <section className="grid gap-px bg-border py-px sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="rounded-none border-0 bg-background">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="size-4 text-muted-foreground" />
                  {title}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed text-muted-foreground">
                {body}
              </CardContent>
            </Card>
          ))}
        </section>

        <Separator />

        <section className="py-20">
          <h2 className="text-sm uppercase tracking-widest text-muted-foreground">
            Connect an agent
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Point any MCP client at the server's <code>/mcp</code> endpoint.
          </p>
          <div className="mt-5 max-w-xl border border-border bg-card">
            <pre className="overflow-x-auto px-4 py-3 text-sm leading-7">
              <code>{MCP_CONFIG}</code>
            </pre>
          </div>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            No built-in authentication. Keep it on a private network or behind a
            proxy that authenticates.
          </p>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-8 text-sm text-muted-foreground">
          <span>MIT licensed</span>
          <a className="hover:text-foreground" href={REPOSITORY}>
            GitHub
          </a>
          <a className="hover:text-foreground" href={`${REPOSITORY}/releases`}>
            Releases
          </a>
          <a className="hover:text-foreground" href={`${REPOSITORY}/issues`}>
            Issues
          </a>
        </div>
      </footer>
    </div>
  );
}
