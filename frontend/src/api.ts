const BASE = '/api';

export interface Stage {
  key: string;
  label: string;
  analysis_only: boolean;
  description: string;
}

export interface Run {
  id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  stages: StageStatus[];
  created_at: string;
  workspace: string;
  results: Record<string, any> | null;
  logs: string[];
}

export interface StageStatus {
  key: string;
  status: 'pending' | 'running' | 'ok' | 'error';
  summary?: string;
  error?: string;
}

export interface FileInfo {
  path: string;
  size: number;
  lines: number;
  type: 'source' | 'artifact';
}

export interface LogsResponse {
  logs: string[];
}

export async function fetchStages(): Promise<Stage[]> {
  const res = await fetch(`${BASE}/stages`);
  if (!res.ok) throw new Error(`Failed to fetch stages: ${res.status}`);
  return res.json();
}

export async function createRun(selectedStages: string[], apiKey = ''): Promise<{ id: string; status: string }> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selected_stages: selectedStages, api_key: apiKey }),
  });
  if (!res.ok) throw new Error(`Failed to create run: ${res.status}`);
  return res.json();
}

export async function getRun(runId: string): Promise<Run> {
  const res = await fetch(`${BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Failed to get run: ${res.status}`);
  return res.json();
}

export async function listRuns(): Promise<{ id: string; status: string; stages: StageStatus[]; created_at: string }[]> {
  const res = await fetch(`${BASE}/runs`);
  if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`);
  return res.json();
}

export async function listFiles(runId: string): Promise<FileInfo[]> {
  const res = await fetch(`${BASE}/runs/${runId}/files`);
  if (!res.ok) throw new Error(`Failed to list files: ${res.status}`);
  const data = await res.json();
  return data.files || [];
}

export async function getFileContent(runId: string, filePath: string): Promise<string> {
  const res = await fetch(`${BASE}/runs/${runId}/file?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) throw new Error(`Failed to get file: ${res.status}`);
  return res.text();
}

export async function getLogs(runId: string): Promise<string[]> {
  const res = await fetch(`${BASE}/runs/${runId}/logs`);
  if (!res.ok) throw new Error(`Failed to get logs: ${res.status}`);
  const data = await res.json();
  return data.logs || [];
}
