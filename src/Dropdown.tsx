import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
export type MenuOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
  removable?: boolean;
};
export function Dropdown({
  value,
  options,
  onChange,
  label,
  icon,
  searchable = false,
  disabled = false,
  className = "",
  message,
  onRemoveOption,
  busy = false,
}: {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  label: string;
  icon?: string;
  searchable?: boolean;
  disabled?: boolean;
  className?: string;
  message?: string | null;
  onRemoveOption?: (value: string) => Promise<boolean> | boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [mounted, setMounted] = useState(false),
    [painted, setPainted] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    [removingValue, setRemovingValue] = useState<string | null>(null);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 320,
    maxHeight: 400,
  });
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const openState = useRef(open);
  openState.current = open;
  const id = useId();
  const filtered = options.filter((o) =>
    (o.label + " " + (o.description ?? ""))
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const selected = options.find((o) => o.value === value);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (option: MenuOption) => {
    if (option.disabled || busy || removingValue !== null) return;
    onChange(option.value);
    close();
  };
  const remove = async (option: MenuOption) => {
    if (!onRemoveOption || !option.removable || busy || removingValue !== null)
      return;
    setRemovingValue(option.value);
    try {
      if ((await onRemoveOption(option.value)) && openState.current)
        popup.current?.focus();
    } catch {
      // Removal callbacks report failures through the owning region's message.
    } finally {
      setRemovingValue(null);
    }
  };
  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery("");
      setActive(
        Math.max(
          0,
          options.findIndex((o) => o.value === value),
        ),
      );
      let next = 0;
      const frame = requestAnimationFrame(() => {
        next = requestAnimationFrame(() => setPainted(true));
      });
      return () => {
        cancelAnimationFrame(frame);
        cancelAnimationFrame(next);
      };
    } else {
      setPainted(false);
      const timer = setTimeout(() => setMounted(false), 160);
      return () => clearTimeout(timer);
    }
  }, [open]);
  useEffect(() => {
    setActive((old) => Math.min(old, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  useLayoutEffect(() => {
    if (!mounted) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      const width = Math.min(360, window.innerWidth - 24);
      const height = Math.min(popup.current?.scrollHeight ?? 400, 420);
      const below = window.innerHeight - rect.bottom - 12;
      const flip = below < Math.min(height, 200) && rect.top > below;
      const maxHeight = Math.max(
        120,
        Math.min(420, flip ? rect.top - 16 : below),
      );
      setPosition({
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: flip
          ? Math.max(12, rect.top - Math.min(height, maxHeight) - 8)
          : rect.bottom + 8,
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    if (open) {
      if (searchable) input.current?.focus();
      else popup.current?.focus();
    }
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mounted, open, searchable]);
  useEffect(() => {
    if (open)
      popup.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, query]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <>
      <button
        ref={trigger}
        className={"dropdown-trigger " + className + (open ? " is-open" : "")}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={mounted ? id : undefined}
        disabled={disabled}
        title={selected?.description || selected?.label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon && <Icon name={icon} size={17} />}
        <span>{selected?.label || label}</span>
        <Icon name="chevron" size={12} />
      </button>
      {mounted &&
        createPortal(
          <div
            className={"overlay-root " + (painted ? "is-open" : "")}
            data-menu-popup
            data-active={open}
          >
            <div className="overlay-dismiss" onPointerDown={close} />
            <div
              ref={popup}
              id={id}
              className="dropdown-popup"
              tabIndex={-1}
              style={position}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.preventDefault();
                  close();
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const direction = e.key === "ArrowDown" ? 1 : -1;
                  let next = active;
                  for (let n = 0; n < filtered.length; n++) {
                    next =
                      (next + direction + filtered.length) % filtered.length;
                    if (!filtered[next]?.disabled) break;
                  }
                  setActive(next);
                }
                if (
                  e.key === "Enter" &&
                  !busy &&
                  removingValue === null &&
                  filtered[active] &&
                  !filtered[active].disabled
                ) {
                  e.preventDefault();
                  choose(filtered[active]);
                }
                if (e.key === "Tab") {
                  setOpen(false);
                }
              }}
            >
              {message && (
                <div className="menu-message" role="status">
                  {message}
                </div>
              )}
              {searchable && (
                <div className="menu-search">
                  <Icon name="search" size={15} />
                  <input
                    ref={input}
                    value={query}
                    placeholder="搜索名称或路径"
                    aria-label={"搜索" + label}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                  />
                </div>
              )}
              <div
                className="menu-options"
                role="listbox"
                aria-label={label}
                aria-activedescendant={
                  filtered[active] ? id + "-" + active : undefined
                }
              >
                {!filtered.length && (
                  <p className="menu-empty">没有匹配的结果</p>
                )}
                {filtered.map((option, index) => {
                  const optionButton = (
                    <button
                      id={id + "-" + index}
                      className="menu-option"
                      role="option"
                      aria-selected={option.value === value}
                      disabled={
                        option.disabled || busy || removingValue !== null
                      }
                      data-active={index === active}
                      title={option.description || option.label}
                      onPointerMove={() => setActive(index)}
                      onClick={() => choose(option)}
                    >
                      <span>
                        <strong>{option.label}</strong>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </span>
                      {option.value === value && (
                        <Icon name="check" size={15} />
                      )}
                    </button>
                  );
                  return (
                    <div key={option.value}>
                      {option.group &&
                        option.group !== filtered[index - 1]?.group && (
                          <div className="menu-group">{option.group}</div>
                        )}
                      {onRemoveOption && option.removable ? (
                        <div className="menu-option-row">
                          {optionButton}
                          <button
                            type="button"
                            className="menu-option-remove"
                            aria-label={`从最近打开移除 ${option.label}`}
                            title="从最近打开移除"
                            disabled={busy || removingValue !== null}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ")
                                e.stopPropagation();
                            }}
                            onClick={() => void remove(option)}
                          >
                            <Icon name="close" size={14} />
                          </button>
                        </div>
                      ) : (
                        optionButton
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
