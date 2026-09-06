'use client';

import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { cn } from '@/lib/cn';

export interface AvatarProps {
  /** Полное имя: из него берутся инициалы, когда фото нет. */
  name: string;
  src?: string;
  className?: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function Avatar({ className, name, src }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'border-border bg-surface-2 inline-flex size-9 shrink-0 overflow-hidden rounded-full border',
        className,
      )}
    >
      {src !== undefined ? (
        <AvatarPrimitive.Image alt={name} className="size-full object-cover" src={src} />
      ) : null}
      <AvatarPrimitive.Fallback className="text-text-muted flex size-full items-center justify-center text-[13px] font-medium">
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
