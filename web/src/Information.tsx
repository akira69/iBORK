import { Github } from "lucide-react";
import guide from "../../docs/usage.md?raw";
import finchLogo from "./assets/finch13.png";

// The shared guide uses only level-two headings and plain paragraphs.
const sections = guide
  .trim()
  .split(/^## /m)
  .filter(Boolean)
  .map((section) => {
    const [title, ...paragraphs] = section.trim().split(/\r?\n\s*\r?\n/);
    return { title, paragraphs };
  });

export function Information() {
  return (
    <article className="information" aria-label="iBORK usage guide">
      {sections.map(({ title, paragraphs }) => (
        <section className="panel data-panel" key={title}>
          <h2>{title}</h2>
          {paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
      <footer className="information-credit">
        <img src={finchLogo} alt="Finch13" width="96" height="96" />
        <p>iBORK by Finch13 · Less bork. More uptime.</p>
        <a
          href="https://github.com/akira69/iBORK"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Github size={20} /> iBORK on GitHub
        </a>
      </footer>
    </article>
  );
}
