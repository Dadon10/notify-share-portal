import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

type PageSize = { width: number; height: number };

/** Renders every page of a PDF at the container's width; `overlay` draws boxes on top of each page. */
export function ContractPdfPages({
  data,
  overlay,
  onPageCount,
  className = "",
}: {
  data: Uint8Array;
  overlay?: (page: number, size: PageSize) => ReactNode;
  onPageCount?: (count: number) => void;
  className?: string;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setPdf(null);
    setError("");
    void (async () => {
      try {
        // Loaded on demand so pdf.js never runs during server rendering.
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // pdf.js transfers the buffer to its worker, so give it a copy.
        loaded = await pdfjs.getDocument({ data: data.slice() }).promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdf(loaded);
        onPageCount?.(loaded.numPages);
      } catch (caught) {
        if (!cancelled)
          setError(
            caught instanceof Error && /password/i.test(caught.message)
              ? "This PDF is password-protected."
              : "The PDF could not be displayed.",
          );
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className={`space-y-4 ${className}`}>
      {error && (
        <p role="alert" className="rounded-md bg-warning-soft p-4 text-sm">
          {error}
        </p>
      )}
      {!pdf && !error && (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading pages…</p>
      )}
      {pdf &&
        width > 0 &&
        Array.from({ length: pdf.numPages }, (_, index) => (
          <PdfPage key={index} pdf={pdf} index={index} width={width} overlay={overlay} />
        ))}
    </div>
  );
}

function PdfPage({
  pdf,
  index,
  width,
  overlay,
}: {
  pdf: PDFDocumentProxy;
  index: number;
  width: number;
  overlay?: ((page: number, size: PageSize) => ReactNode) | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<PageSize | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      // getViewport applies the page's own rotation, so boxes are measured on the page as people see it.
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      } as Parameters<typeof page.render>[0]);
      try {
        await task.promise;
      } catch {
        // Cancelled by a re-render.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, index, width]);

  return (
    <div
      className="relative mx-auto w-fit rounded-sm bg-white shadow-md ring-1 ring-border"
      data-page={index}
    >
      <canvas ref={canvasRef} className="block" aria-label={`Page ${index + 1}`} />
      {size && overlay && <div className="absolute inset-0">{overlay(index, size)}</div>}
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-foreground/70 px-1.5 py-0.5 text-[10px] font-semibold text-background">
        {index + 1} / {pdf.numPages}
      </span>
    </div>
  );
}
