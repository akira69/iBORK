import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ label, text }: { label: string; text: string }) {
  const [result, setResult] = useState("");
  useEffect(() => {
    if (result !== "Copied") return;
    const timer = window.setTimeout(() => setResult(""), 1800);
    return () => window.clearTimeout(timer);
  }, [result]);
  return (
    <span className="copy-action">
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={!text}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setResult("Copied");
          } catch {
            setResult("Select the text and copy manually.");
          }
        }}
      >
        {result === "Copied" ? <Check /> : <Copy />}
      </button>
      <small
        role="status"
        className={result === "Copied" ? "sr-only" : undefined}
      >
        {result}
      </small>
    </span>
  );
}
