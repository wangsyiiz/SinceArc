import { useEffect, useState } from "react";

import { asCmdError } from "@/lib/ipc";
import type { AgentCaps } from "@/lib/ipc/types";
import {
  delegateCapsLabel,
  delegateCapsNote,
  delegateErrorMessage,
  delegateTargetCaps,
} from "@/lib/delegate-target";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Textarea } from "./ui/Field";

export function DelegateDialog({
  open,
  targetName,
  profile,
  onClose,
  onSubmit,
  onDelegated,
}: {
  open: boolean;
  targetName: string;
  profile: { caps: AgentCaps | null } | undefined;
  onClose: () => void;
  onSubmit: (task: string) => Promise<void>;
  onDelegated: () => void;
}) {
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caps = delegateTargetCaps(profile);
  const note = delegateCapsNote(caps);
  const canSubmit = task.trim().length > 0 && !submitting;

  useEffect(() => {
    if (!open) return;
    setTask("");
    setError(null);
    setSubmitting(false);
  }, [open, targetName]);

  const requestClose = () => {
    if (!submitting) onClose();
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(task);
      onDelegated();
      onClose();
    } catch (e) {
      const err = asCmdError(e);
      setError(delegateErrorMessage(err.code, targetName));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      title={`派活给 ${targetName}`}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={submitting} onClick={requestClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={submitting}
            loadingText="派活中…"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            派活
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-caption text-ink-3">档位</span>
        <span className="text-caption text-ink-3">{delegateCapsLabel(caps)}</span>
      </div>
      {note && <p className="mt-1 text-caption text-ink-3">{note}</p>}

      <Textarea
        autoFocus
        rows={3}
        value={task}
        disabled={submitting}
        aria-label="任务正文"
        placeholder="让 TA 做什么？这段文字就是任务全文。"
        className="mt-3 max-h-48"
        onChange={(event) => setTask(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />

      {error && (
        <p className="mt-2 break-all text-caption text-danger-1" aria-live="polite">
          {error}
        </p>
      )}

      <p className="mt-2 text-micro text-ink-3">Ctrl/Cmd+Enter 派活 · Esc 关闭</p>
    </Dialog>
  );
}
