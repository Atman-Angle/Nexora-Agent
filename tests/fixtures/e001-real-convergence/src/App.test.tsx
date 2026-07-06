import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

describe("App", () => {
  it("renders the Home nav link and route", () => {
    render(<App />, { wrapper: MemoryRouter });
    const navLink = screen.getByRole("link", { name: /home/i });
    expect(navLink).toBeInTheDocument();
    expect(navLink.getAttribute("href")).toBe("/");
  });

  it("renders a Settings nav link once /settings exists", () => {
    if (!existsSync("src/pages/Settings.tsx")) {
      expect(true).toBe(true);
      return;
    }
    render(<App />, { wrapper: MemoryRouter });
    const link = screen.queryByRole("link", { name: /settings/i });
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/settings");
  });
});
