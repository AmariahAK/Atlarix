import React, { forwardRef } from "react";

export type Props<T extends string = string> = {
  value: T;
  onChange?: (v: T) => void;
};

export const Box = forwardRef<HTMLDivElement, Props>(function Box({ value }, ref) {
  return (
    <motion.div ref={ref}>
      <span>{value}</span>
    </motion.div>
  );
});

const motion = {
  div: ({ children, ref }: { children: React.ReactNode; ref?: React.Ref<HTMLDivElement> }) => (
    <motion.div ref={ref}>{children}</motion.div>
  ),
};

export default function App() {
  return <Box value="hi" />;
}
