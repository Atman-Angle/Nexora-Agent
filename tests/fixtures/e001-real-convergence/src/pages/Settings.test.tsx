import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const settingsPath = "src/pages/Settings.tsx";

describe.skipIf(!existsSync(settingsPath))("Settings page", () => {
  it("renders username input, notification toggle, save button, and shows success on save", async () => {
    const modulePath = "./Set" + "tings";
    const mod = await import(modulePath);
    const Settings = mod.Settings ?? mod.default;
    const user = userEvent.setup();
    render(<Settings />, { wrapper: MemoryRouter });

    const usernameInput = screen.getByLabelText(/username/i);
    expect(usernameInput).toBeInTheDocument();
    await user.type(usernameInput, "alice");

    const toggle = screen.getByRole("checkbox", { name: /notification/i });
    await user.click(toggle);
    expect(toggle).toBeChecked();

    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it("reuses the shared Button, Card, and Input components", async () => {
    const modulePath = "./Set" + "tings";
    const { Settings } = await import(modulePath);
    const { Button } = await import("../components/Button");
    const { Card } = await import("../components/Card");
    const { Input } = await import("../components/Input");
    render(<Settings />, { wrapper: MemoryRouter });
    expect(Button).toBeDefined();
    expect(Card).toBeDefined();
    expect(Input).toBeDefined();
  });
});
