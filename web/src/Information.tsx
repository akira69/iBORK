import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  ChevronRight,
  Compass,
  Github,
  Grid2X2,
  List,
  Monitor,
  PanelTop,
  Server,
  SquareTerminal,
  Unplug,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import guide from "../../docs/usage.md?raw";
import finchLogo from "./assets/finch13.png";
import "./information.css";

const icons: Record<string, LucideIcon> = {
  "getting-around": Compass,
  "ibork-assistant": BrainCircuit,
  "remote-consoles": Monitor,
  "power-and-energy": Zap,
  "dashboard-layouts": Grid2X2,
  "sensors-and-management": Activity,
  "touchscreen-display": PanelTop,
  "terminals-and-media": SquareTerminal,
  "connection-help": Unplug,
};

// The shared guide uses chapters, subheadings, bold control labels and inline code.
const [intro, ...chapters] = guide
  .trim()
  .split(/^## /m)
  .slice(1)
  .map((chapter) => {
    const [title, ...blocks] = chapter.trim().split(/\r?\n\s*\r?\n/);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const [lead, ...topics] = blocks.join("\n\n").split(/^### /m);
    return { title, slug, lead: lead.trim(), topics };
  });

function paragraphs(text: string) {
  return text
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((p) => (
      <p key={p}>
        {p.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
          if (part.startsWith("**"))
            return <strong key={i}>{part.slice(2, -2)}</strong>;
          if (part.startsWith("`"))
            return <code key={i}>{part.slice(1, -1)}</code>;
          return part;
        })}
      </p>
    ));
}

export function Information({ emptyFleet = false }: { emptyFleet?: boolean }) {
  useEffect(() => {
    // The guide mounts after the session and device list have loaded.
    if (location.hash.startsWith("#guide-"))
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);
  return (
    <article className="information" aria-label="iBORK usage guide">
      <header className="guide-cover">
        <div className="guide-intro">
          <h2>{intro.title}</h2>
          {paragraphs(intro.lead)}
          <div className="guide-shortcuts">
            {emptyFleet && (
              <a href="#add-first-server">
                <Server />
                Add your first server
              </a>
            )}
            <a href="#guide-contents">
              <List /> Browse topics
            </a>
            <a href="#guide-ibork-assistant">
              <BrainCircuit /> iBORK Assistant <ArrowDown />
            </a>
          </div>
        </div>
        <div className="guide-diagram" aria-hidden="true">
          <div className="guide-rack">
            {[1, 2, 3].map((unit) => (
              <Server key={unit} />
            ))}
          </div>
          <div className="guide-signals">
            <span>KVM</span>
            <span>IPMI</span>
            <span>Telemetry</span>
          </div>
        </div>
      </header>
      <div className="guide-body">
        <nav
          id="guide-contents"
          className="guide-contents"
          aria-label="Guide contents"
          tabIndex={-1}
        >
          <h2>
            <List /> On this page
          </h2>
          <div>
            {chapters.map(({ title, slug }) => {
              const Icon = icons[slug] ?? BookOpen;
              return (
                <a key={slug} href={`#guide-${slug}`}>
                  <Icon />
                  {title}
                  <ChevronRight />
                </a>
              );
            })}
          </div>
        </nav>
        <div className="guide-chapters">
          {chapters.map(({ title, slug, lead, topics }) => {
            const Icon = icons[slug] ?? BookOpen;
            return (
              <section
                key={slug}
                id={`guide-${slug}`}
                tabIndex={-1}
                className="guide-chapter"
              >
                <h2>
                  <Icon />
                  {title}
                </h2>
                {paragraphs(lead)}
                {topics.length > 0 && (
                  <div className="guide-topics">
                    {topics.map((topic) => {
                      const [heading, ...body] = topic.trim().split("\n\n");
                      return (
                        <div key={heading}>
                          <h3>{heading}</h3>
                          {paragraphs(body.join("\n\n"))}
                        </div>
                      );
                    })}
                  </div>
                )}
                <a className="guide-return" href="#guide-contents">
                  <ArrowUp /> Contents
                </a>
              </section>
            );
          })}
        </div>
      </div>
      <footer className="information-credit">
        <img src={finchLogo} alt="Finch13" width="44" height="44" />
        <p>iBORK by Finch13 · Less bork. More uptime.</p>
        <a
          href="https://github.com/akira69/iBORK/blob/main/docs/usage.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Github /> Read the handbook on GitHub <ArrowUpRight />
        </a>
      </footer>
    </article>
  );
}
