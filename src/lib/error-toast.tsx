import { WarningIcon } from "@phosphor-icons/react";

/**
 * An error message as a toast. Errors are shown only as toasts, never drawn
 * inline. Electron's IPC wrapper ("Error invoking remote method
 * 'agent:switchThread': Error: …") is stripped, and a short message becomes
 * the title on its own.
 */
export function errorToast(error: string) {
  const message =
    error
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/^(?:Error:\s*)+/, "")
      .trim() || "Something went wrong.";
  const icon = <WarningIcon className="size-5 text-red-500" />;
  return message.length <= 80
    ? { icon, title: message }
    : { icon, title: "Something went wrong", description: message };
}
