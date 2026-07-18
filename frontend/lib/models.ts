"use client";

// Model picker state: fetches the available Codex models from /api/models and
// tracks the active selection (persisted in localStorage, defaulting to the
// server's default model). The selected id is sent with each turn.

import { useCallback, useEffect, useState } from "react";

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort?: string;
}

const MODEL_KEY = "codex-model";

export function useModelPicker() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Seed synchronously from the last choice so the picker shows a value on reload
  // instead of flashing blank. (This component only mounts client-side.)
  const [model, setModelState] = useState<string | null>(() =>
    typeof window !== "undefined" ? window.localStorage.getItem(MODEL_KEY) : null,
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setModels((d.models as ModelInfo[]) ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Once the list loads, ensure a valid selection: keep the stored one if it's
  // still offered, else fall back to the server default (else the first model).
  useEffect(() => {
    if (models.length === 0) return;
    setModelState((cur) =>
      cur && models.some((m) => m.id === cur)
        ? cur
        : models.find((m) => m.isDefault)?.id ?? models[0].id,
    );
  }, [models]);

  const setModel = useCallback((id: string) => {
    setModelState(id);
    try {
      window.localStorage.setItem(MODEL_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  return { models, model, setModel };
}
