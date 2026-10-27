import type { ReactNode } from 'react';

export const StyleComponent = (classes: string) => {
  function Component({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) {
    return <div className={`${classes} ${className ?? ''}`}>{children}</div>;
  }
  return Component;
};

export const VerticalStack = StyleComponent(
  'w-full h-full flex flex-col overflow-hidden',
);

export function StackGrow({
  children,
  outerClassName,
  className,
}: {
  children: ReactNode;
  outerClassName?: string;
  className?: string;
}) {
  return (
    <div className={`flex-1 overflow-hidden ${outerClassName ?? ''}`}>
      <div className={`h-full w-full overflow-hidden ${className ?? ''}`}>
        {children}
      </div>
    </div>
  );
}

export const StackFixed = StyleComponent('flex-none');
