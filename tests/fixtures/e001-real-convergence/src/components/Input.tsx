import type { InputHTMLAttributes } from "react";

export function Input({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="input-field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}
