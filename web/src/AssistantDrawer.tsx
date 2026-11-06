import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, Settings, X } from "lucide-react";
import brain from "./assets/assistant-brain.png";
import { assistantCopy } from "./assistant-copy";
import "./Assistant.css";

const Assistant = lazy(() => import("./Assistant"));
export type SettingsSection = "provider" | "scope" | "connect";
export type AssistantControls = {
  openAssistant: () => void;
  settings: ReactNode;
  settingsRequest: number;
};

export function AssistantDrawer({
  csrf,
  onSettings,
  onLayout,
  children,
}: {
  csrf: string;
  onSettings?: () => void;
  onLayout?: (id: string) => void;
  children: (controls: AssistantControls) => ReactNode;
}) {
  const t = assistantCopy(navigator.language);
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [settingsRequest, setSettingsRequest] = useState(0);
  function showDrawer() {
    const node = dialog.current;
    if (!node) return;
    if (window.matchMedia("(min-width: 1200px)").matches) node.show();
    else node.showModal();
  }
  function openAssistant() {
    setLoaded(true);
    if (!dialog.current?.open) showDrawer();
    setOpened(true);
  }
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1200px)");
    function resize() {
      if (!dialog.current?.open) return;
      dialog.current.close();
      showDrawer();
    }
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  const settings = (
    <details
      className="panel data-panel assistant-settings"
      onToggle={(e) => {
        if (e.currentTarget.open) setLoaded(true);
      }}
    >
      <summary>
        <Settings size={18} /> {t.settings}
      </summary>
      <div ref={setHost} />
    </details>
  );
  return (
    <>
      {children({
        openAssistant,
        settings,
        settingsRequest,
      })}
      <button
        className="assistant-tab"
        onClick={openAssistant}
        title={t.title}
        aria-label={t.title}
        aria-haspopup="dialog"
        aria-expanded={opened}
        aria-controls="assistant-drawer"
      >
        <ChevronLeft size={13} />
        <img src={brain} alt="" width="38" height="32" />
      </button>
      <dialog
        id="assistant-drawer"
        className="assistant-drawer"
        ref={dialog}
        aria-labelledby="assistant-title"
        closedby="closerequest"
        onClose={(e) => setOpened(e.currentTarget.open)}
      >
        <header>
          <img src={brain} alt="" width="38" height="32" />
          <h2 id="assistant-title">{t.title}</h2>
          <button
            aria-label={t.settings}
            title={t.settings}
            onClick={() => {
              dialog.current?.close();
              onSettings?.();
              setSettingsRequest((previous) => previous + 1);
            }}
          >
            <Settings size={18} />
          </button>
          <button
            autoFocus
            onClick={() => dialog.current?.close()}
            aria-label={t.close}
          >
            <X size={20} />
          </button>
        </header>
        {loaded && (
          <Suspense fallback={<p role="status">{t.checking}</p>}>
            <Assistant
              csrf={csrf}
              onLayout={onLayout}
              host={host}
              settingsRequest={settingsRequest}
              opened={opened}
            />
          </Suspense>
        )}
      </dialog>
    </>
  );
}
