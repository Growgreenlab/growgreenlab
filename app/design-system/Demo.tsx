"use client";

/**
 * Interactive islands for the /design-system specimen page:
 * the Modal shell demo (open/close, Esc, focus trap).
 */
import { useState } from "react";
import { Button, Modal } from "../../components/ui";

export default function Demo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open modal shell
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Modal shell — specimen">
        <p style={{ marginTop: 0 }}>
          Portal-rendered dialog with focus trap, Esc and backdrop close, and focus returned to the
          opener. Light surface by design — the shared overlay never inherits chart-stage tokens.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="accent" onClick={() => setOpen(false)}>
            Subscribe
          </Button>
        </div>
      </Modal>
    </div>
  );
}
