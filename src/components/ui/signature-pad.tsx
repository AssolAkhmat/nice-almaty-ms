'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from './button';
import { cn } from '@/lib/cn';

/**
 * Поле для подписи: рисование на canvas и экспорт в PNG
 * (docs/04-MODULES/01-onboarding.md, «Договор»).
 *
 * Указатель один — и мышь, и палец приходят событиями pointer, поэтому
 * отдельной ветки для касаний нет. Экспорт отдаёт прозрачный PNG:
 * подпись ложится на страницу договора, а не на белый прямоугольник.
 */
const WIDTH = 600;
const HEIGHT = 200;
const LINE_WIDTH = 2.5;

export interface SignaturePadProps {
  className?: string;
  clearLabel: string;
  disabled?: boolean;
  onChange: (isEmpty: boolean) => void;
  /** Экспорт вызывается снаружи: страница решает, когда отправлять подпись. */
  exportRef: React.RefObject<(() => Promise<Blob | null>) | null>;
}

export function SignaturePad({
  className,
  clearLabel,
  disabled = false,
  exportRef,
  onChange,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [isEmpty, setEmpty] = useState(true);

  function context(): CanvasRenderingContext2D | null {
    const canvas = canvasRef.current;

    return canvas === null ? null : canvas.getContext('2d');
  }

  function position(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();

    // Холст растянут по ширине контейнера: координаты приводятся к его системе.
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (disabled) {
      return;
    }

    const ctx = context();
    if (ctx === null) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;

    const { x, y } = position(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawing.current) {
      return;
    }

    const ctx = context();
    if (ctx === null) {
      return;
    }

    const { x, y } = position(event);
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    ctx.lineTo(x, y);
    ctx.stroke();

    if (isEmpty) {
      setEmpty(false);
      onChange(false);
    }
  }

  function end(): void {
    drawing.current = false;
  }

  function clear(): void {
    const canvas = canvasRef.current;
    const ctx = context();
    if (canvas === null || ctx === null) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    onChange(true);
  }

  // Экспорт отдаётся наружу после отрисовки: во время рендера ref трогать нельзя.
  useEffect(() => {
    exportRef.current = () =>
      new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (canvas === null || isEmpty) {
          resolve(null);

          return;
        }

        canvas.toBlob((blob) => {
          resolve(blob);
        }, 'image/png');
      });

    return () => {
      exportRef.current = null;
    };
  }, [exportRef, isEmpty]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <canvas
        aria-label="signature"
        className="rounded-card border-border w-full touch-none border bg-white"
        data-testid="signature-canvas"
        height={HEIGHT}
        onPointerCancel={end}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        ref={canvasRef}
        width={WIDTH}
      />

      <div>
        <Button disabled={disabled || isEmpty} onClick={clear} type="button" variant="ghost">
          {clearLabel}
        </Button>
      </div>
    </div>
  );
}
