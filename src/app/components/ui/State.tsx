import React from "react";
import { Button } from "./Button";
import { Card } from "./Card";
import { Icon, IconName } from "./Icon";

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = "Tentar novamente",
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Card className="border-rose-800/80 bg-rose-950/40 p-6 text-center">
      <Icon
        name="alertTriangle"
        className="mx-auto h-6 w-6 text-rose-300"
      />
      <p className="mt-2 font-semibold text-rose-100">{title}</p>
      {message ? (
        <p className="mt-1 text-sm text-rose-200/90">{message}</p>
      ) : null}
      {onRetry ? (
        <Button
          variant="danger"
          onClick={onRetry}
          className="mt-4"
          aria-label={retryLabel}
        >
          <Icon name="refresh" className="h-4 w-4" />
          {retryLabel}
        </Button>
      ) : null}
    </Card>
  );
}

export function EmptyState({
  icon = "search",
  title,
  description,
  action,
  className = "",
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-8 text-center ${className}`}
    >
      <Icon name={icon} className="mx-auto h-6 w-6 text-slate-500" />
      <p className="mt-2 text-sm font-semibold text-slate-200">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
