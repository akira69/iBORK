import { useState } from "react";
import {
  Activity,
  Zap,
  Server,
  Monitor,
  Plus,
  Check,
  Search,
} from "lucide-react";
import {
  catalog,
  widgetGroups,
  widgetAvailable,
  type DashboardWidget,
  type WidgetKind,
} from "./dashboard-layout";

const groupIcons = [Activity, Zap, Server, Monitor];

export function WidgetCatalog({
  widgets,
  jetAvailable,
  vncAvailable,
  cometAvailable,
  managementAvailable,
  add,
}: {
  widgets: DashboardWidget[];
  jetAvailable?: boolean;
  vncAvailable?: boolean;
  cometAvailable?: boolean;
  managementAvailable?: boolean;
  add: (kind: WidgetKind, sensorMode?: "fixed" | "selectable") => void;
}) {
  const [selectedGroup, setGroup] = useState("Health & cooling");
  const [query, setQuery] = useState("");
  const groups = Object.entries(widgetGroups)
    .map(([name, kinds], index) => ({
      name,
      Icon: groupIcons[index],
      kinds: kinds.filter((kind) =>
        widgetAvailable(
          kind,
          jetAvailable,
          vncAvailable,
          managementAvailable,
          cometAvailable,
        ),
      ),
    }))
    .filter((group) => group.kinds.length);
  const activeGroup = groups.some((group) => group.name === selectedGroup)
    ? selectedGroup
    : groups[0]?.name;
  const search = query.trim().toLowerCase();
  const choices = groups
    .flatMap((group) =>
      group.kinds.flatMap((kind) =>
        (kind === "sensor"
          ? (["fixed", "selectable"] as const)
          : (["fixed"] as const)
        ).map((mode) => ({
          kind,
          mode,
          group: group.name,
          Icon: group.Icon,
          title:
            mode === "selectable" ? "Selectable sensor" : catalog[kind].title,
        })),
      ),
    )
    .filter((choice) =>
      search
        ? `${choice.title} ${choice.group}`.toLowerCase().includes(search)
        : choice.group === activeGroup,
    );
  return (
    <section className="widget-catalog" aria-label="Widget catalog">
      <header>
        <h2>
          <Plus size={18} /> Add widgets <small>{widgets.length}/24</small>
        </h2>
        <label className="widget-search">
          <Search size={16} />
          <input
            type="search"
            aria-label="Find widget"
            placeholder="Find a widget…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      <nav aria-label="Widget categories">
        {groups.map(({ name, Icon }) => (
          <button
            key={name}
            aria-pressed={!search && name === activeGroup}
            onClick={() => {
              setGroup(name);
              setQuery("");
            }}
          >
            <Icon size={16} />
            {name}
          </button>
        ))}
      </nav>
      <div className="widget-choices">
        {choices.map(({ kind, mode, title, Icon, group }) => {
          const added =
            kind !== "sensor" && widgets.some((widget) => widget.kind === kind);
          return (
            <button
              className="widget-choice"
              key={`${kind}-${mode}`}
              aria-label={title}
              title={
                added ? `${title} is already on your dashboard` : `Add ${title}`
              }
              disabled={added || widgets.length >= 24}
              onClick={() => add(kind, mode)}
            >
              <Icon size={20} />
              <span>
                <strong>{title}</strong>
                {search && <small>{group}</small>}
              </span>
              <span className="widget-choice-action">
                {added ? <Check size={14} /> : <Plus size={14} />}
                {added ? "Added" : "Add"}
              </span>
            </button>
          );
        })}
        {!choices.length && <p className="empty-data">No matching widgets.</p>}
      </div>
    </section>
  );
}
