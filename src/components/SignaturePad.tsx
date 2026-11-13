import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const INK = "#111827";
const PAD_HEIGHT = 200;

/**
 * "Draw signature" button that opens a pad for signing with a finger, stylus or mouse. The drawing is handed back
 * as a PNG file, so it goes through the same save-and-clean path as an uploaded signature image.
 */
export function DrawSignatureButton({
  onDrawn,
  disabled,
  label = "Draw signature",
  variant = "link",
}: {
  onDrawn: (file: File) => void | Promise<void>;
  disabled?: boolean;
  label?: string;
  variant?: "link" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "link" ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary disabled:opacity-50"
        >
          <PenLine className="h-4 w-4" />
          {label}
        </button>
      ) : (
        <Button type="button" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
          <PenLine className="h-4 w-4" />
          {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Draw your signature</DialogTitle>
            <DialogDescription>
              Sign in the box with your finger, a stylus or the mouse. It is saved as your signature
              for future documents too.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <SignaturePad
              onCancel={() => setOpen(false)}
              onDone={async (file) => {
                setOpen(false);
                await onDrawn(file);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SignaturePad({
  onDone,
  onCancel,
}: {
  onDone: (file: File) => void | Promise<void>;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [inkLength, setInkLength] = useState(0);
  const [error, setError] = useState("");

  // Size the canvas to its box (and the screen's pixel density) so strokes stay sharp on phones.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(PAD_HEIGHT * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = INK;
    context.fillStyle = INK;
  }, []);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = point(event);
    drawing.current = at;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    // A dot, so a tap still leaves ink (e.g. dotting an i).
    context.beginPath();
    context.arc(at.x, at.y, 1.4, 0, Math.PI * 2);
    context.fill();
    setError("");
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const from = drawing.current;
    if (!from) return;
    event.preventDefault();
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    // Pen pressure when available; a steady line for mouse and most fingers.
    const pressure = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
    const to = point(event);
    context.lineWidth = 1.6 + pressure * 2.2;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    drawing.current = to;
    setInkLength((length) => length + Math.hypot(to.x - from.x, to.y - from.y));
  }

  function end() {
    drawing.current = null;
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    setInkLength(0);
    setError("");
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (inkLength < 60) {
      setError("Your signature is too short. Sign across the box.");
      return;
    }
    // Flatten onto white, like ink on paper; the server removes the background again when it cleans the signature.
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const context = flat.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, flat.width, flat.height);
    context.drawImage(canvas, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => flat.toBlob(resolve, "image/png"));
    if (!blob) {
      setError("Could not capture the signature. Try again.");
      return;
    }
    await onDone(new File([blob], "drawn-signature.png", { type: "image/png" }));
  }

  return (
    <div className="space-y-3">
      <div className="relative rounded-md border-2 border-dashed bg-white">
        <canvas
          ref={canvasRef}
          aria-label="Signature drawing area"
          className="block w-full cursor-crosshair touch-none"
          style={{ height: PAD_HEIGHT }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
        />
        <div className="pointer-events-none absolute inset-x-6 bottom-10 border-b border-gray-300" />
        {inkLength === 0 && (
          <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-gray-400">
            Sign here
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={clear} disabled={!inkLength}>
          Clear
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={!inkLength}>
          Use this signature
        </Button>
      </div>
    </div>
  );
}
