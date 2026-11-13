import { useRef, type DragEvent, type PointerEvent } from "react";
import { Check, X } from "lucide-react";
import {
  CONTRACT_FIELD_DEFAULT_SIZE,
  CONTRACT_FIELD_LABELS,
  type ContractFieldInput,
  type ContractFieldKind,
} from "@/lib/contract-types";

/** Distinct, colour-blind-friendly hues so each signer's boxes are easy to tell apart. */
export const SIGNER_COLORS = [
  "#2563eb",
  "#d97706",
  "#059669",
  "#db2777",
  "#7c3aed",
  "#0891b2",
  "#65a30d",
  "#dc2626",
];

export function signerColor(index: number) {
  return SIGNER_COLORS[index % SIGNER_COLORS.length] ?? "#2563eb";
}

export type EditableField = ContractFieldInput & { key: string };

export const FIELD_DRAG_TYPE = "application/x-contract-field";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Creates a box of the default size centred on a point, kept fully on the page. */
export function newField(
  kind: ContractFieldKind,
  signerId: string,
  page: number,
  centerX: number,
  centerY: number,
): EditableField {
  const size = CONTRACT_FIELD_DEFAULT_SIZE[kind];
  return {
    key: crypto.randomUUID(),
    kind,
    signerId,
    page,
    width: size.width,
    height: size.height,
    x: clamp(centerX - size.width / 2, 0, 1 - size.width),
    y: clamp(centerY - size.height / 2, 0, 1 - size.height),
  };
}

export function EditableFieldLayer({
  page,
  size,
  fields,
  signerIndex,
  signerName,
  armed,
  selectedKey,
  onSelect,
  onChange,
  onPlace,
  onRemove,
}: {
  page: number;
  size: { width: number; height: number };
  fields: EditableField[];
  signerIndex: (signerId: string) => number;
  signerName: (signerId: string) => string;
  armed: ContractFieldKind | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onChange: (key: string, patch: Partial<EditableField>) => void;
  onPlace: (kind: ContractFieldKind, page: number, x: number, y: number) => void;
  onRemove: (key: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    key: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    field: EditableField;
  } | null>(null);

  function relative(clientX: number, clientY: number) {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }

  function startGesture(event: PointerEvent, field: EditableField, mode: "move" | "resize") {
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    onSelect(field.key);
    gesture.current = { key: field.key, mode, startX: event.clientX, startY: event.clientY, field };
  }

  function moveGesture(event: PointerEvent) {
    const active = gesture.current;
    if (!active) return;
    const dx = (event.clientX - active.startX) / size.width;
    const dy = (event.clientY - active.startY) / size.height;
    const field = active.field;
    if (active.mode === "move") {
      onChange(active.key, {
        x: clamp(field.x + dx, 0, 1 - field.width),
        y: clamp(field.y + dy, 0, 1 - field.height),
      });
    } else {
      onChange(active.key, {
        width: clamp(field.width + dx, 0.03, 1 - field.x),
        height: clamp(field.height + dy, 0.015, 1 - field.y),
      });
    }
  }

  function endGesture() {
    gesture.current = null;
  }

  function drop(event: DragEvent) {
    const kind = event.dataTransfer.getData(FIELD_DRAG_TYPE) as ContractFieldKind;
    if (!kind) return;
    event.preventDefault();
    const point = relative(event.clientX, event.clientY);
    onPlace(kind, page, point.x, point.y);
  }

  return (
    <div
      ref={layerRef}
      className={`absolute inset-0 ${armed ? "cursor-crosshair" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) event.preventDefault();
      }}
      onDrop={drop}
      onPointerDown={(event) => {
        if (event.target !== layerRef.current) return;
        if (armed) {
          const point = relative(event.clientX, event.clientY);
          onPlace(armed, page, point.x, point.y);
        } else onSelect(null);
      }}
    >
      {fields.map((field) => {
        const color = signerColor(signerIndex(field.signerId));
        const selected = field.key === selectedKey;
        return (
          <div
            key={field.key}
            role="button"
            tabIndex={0}
            aria-label={`${CONTRACT_FIELD_LABELS[field.kind]} for ${signerName(field.signerId)}. Drag to move; arrow keys nudge; Delete removes.`}
            onPointerDown={(event) => startGesture(event, field, "move")}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.02 : 0.005;
              const moves: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const move = moves[event.key];
              if (move) {
                event.preventDefault();
                onChange(field.key, {
                  x: clamp(field.x + move[0], 0, 1 - field.width),
                  y: clamp(field.y + move[1], 0, 1 - field.height),
                });
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                onRemove(field.key);
              }
            }}
            onFocus={() => onSelect(field.key)}
            className="group absolute flex touch-none select-none items-end overflow-visible rounded-sm border-2 text-[10px] font-semibold leading-none outline-none"
            style={{
              left: `${field.x * 100}%`,
              top: `${field.y * 100}%`,
              width: `${field.width * 100}%`,
              height: `${field.height * 100}%`,
              borderColor: color,
              background: `${color}22`,
              color,
              boxShadow: selected ? `0 0 0 3px ${color}55` : undefined,
              cursor: "move",
            }}
          >
            <span className="pointer-events-none truncate px-1 pb-0.5">
              {CONTRACT_FIELD_LABELS[field.kind]} · {signerName(field.signerId)}
            </span>
            <button
              type="button"
              aria-label="Remove this place"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(field.key);
              }}
              className={`absolute -right-2.5 -top-2.5 grid h-5 w-5 place-items-center rounded-full bg-background shadow ring-1 ring-border ${selected ? "" : "opacity-0 group-hover:opacity-100"}`}
              style={{ color }}
            >
              <X className="h-3 w-3" />
            </button>
            <span
              aria-hidden
              onPointerDown={(event) => startGesture(event, field, "resize")}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border-2 bg-background"
              style={{ borderColor: color }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Shows where each person signs; the viewer's own outstanding places are highlighted. */
export function ReadonlyFieldLayer({
  fields,
  signerIndex,
  highlightSignerId,
}: {
  fields: {
    id: string;
    signerId: string;
    kind: ContractFieldKind;
    x: number;
    y: number;
    width: number;
    height: number;
    completedAt: string | null;
    signerName: string;
  }[];
  signerIndex: (signerId: string) => number;
  highlightSignerId: string | null;
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {fields.map((field) => {
        if (field.completedAt) {
          return (
            <span
              key={field.id}
              title={`${CONTRACT_FIELD_LABELS[field.kind]} completed by ${field.signerName}`}
              className="absolute grid h-4 w-4 place-items-center rounded-full bg-success text-success-foreground"
              style={{
                left: `calc(${(field.x + field.width) * 100}% - 0.5rem)`,
                top: `calc(${field.y * 100}% - 0.5rem)`,
              }}
            >
              <Check className="h-3 w-3" />
            </span>
          );
        }
        const mine = field.signerId === highlightSignerId;
        const color = signerColor(signerIndex(field.signerId));
        return (
          <div
            key={field.id}
            className={`absolute flex items-end rounded-sm border-2 text-[10px] font-semibold leading-none ${mine ? "animate-pulse" : "border-dashed opacity-70"}`}
            style={{
              left: `${field.x * 100}%`,
              top: `${field.y * 100}%`,
              width: `${field.width * 100}%`,
              height: `${field.height * 100}%`,
              borderColor: color,
              background: `${color}${mine ? "2e" : "14"}`,
              color,
            }}
          >
            <span className="truncate px-1 pb-0.5">
              {mine
                ? `Your ${CONTRACT_FIELD_LABELS[field.kind].toLowerCase()}`
                : `${CONTRACT_FIELD_LABELS[field.kind]} · ${field.signerName}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
