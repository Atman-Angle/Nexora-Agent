import type { ButtonHTMLAttributes } from "react";

export function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props}>{children}</button>;
}
