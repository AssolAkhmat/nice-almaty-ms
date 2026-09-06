'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('border-border flex gap-1 overflow-x-auto border-b', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'text-text-muted inline-flex h-11 items-center border-b-2 border-transparent px-3 text-[15px] whitespace-nowrap transition-colors duration-150',
        'hover:text-text',
        /* Активная вкладка подсвечивается жёлтым — это второй допустимый
           случай использования акцента (docs/05-DESIGN-SYSTEM.md). */
        'data-[state=active]:border-accent data-[state=active]:text-text data-[state=active]:font-medium',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-4', className)} {...props} />;
}
