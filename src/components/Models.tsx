import { useState, useEffect, useCallback } from 'react';
import { ModelStatus, ModelProgressInfo } from '../types';

export function Models() {
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    try {
      setModels(await api.getModelStatus());
    } catch {
      /* 主进程未就绪时忽略 */
    }
  }, []);

  useEffect(() => {
    load();
    const api = window.electronAPI;
    if (!api) return;
    const off = api.onModelProgress((info: ModelProgressInfo) => {
      if (info.kind === 'download' && typeof info.percent === 'number') {
        const percent: number = info.percent;
        setProgress(p => ({ ...p, [info.id]: percent }));
      }
      if (info.kind === 'running' || info.kind === 'stopped') {
        load();
      }
    });
    const timer = setInterval(load, 3000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [load]);

  const setBusyFlag = (id: string, v: boolean) =>
    setBusy(b => ({ ...b, [id]: v }));

  const handleDownload = async (id: string) => {
    setError('');
    setBusyFlag(id, true);
    try {
      await window.electronAPI?.downloadModel(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
    } finally {
      setBusyFlag(id, false);
      setProgress(p => {
        const next: Record<string, number> = {};
        for (const k of Object.keys(p)) {
          if (k !== id) next[k] = p[k];
        }
        return next;
      });
    }
  };

  const handleStart = async (id: string) => {
    setError('');
    setBusyFlag(id, true);
    try {
      await window.electronAPI?.startModel(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
    } finally {
      setBusyFlag(id, false);
    }
  };

  const handleStop = async (id: string) => {
    await window.electronAPI?.stopModel(id);
    load();
  };

  const binProgress = progress['__bin__'];

  return (
    <div className="source-manager">
      <div className="source-header">
        <h1>本地模型</h1>
      </div>

      <div className="source-info">
        <p>🤖 AI 翻译 / 问答 / 语义检索都由本地模型驱动，无需联网。首次使用点下载（走国内镜像），之后打开软件自动启动。</p>
      </div>

      {error && <p className="search-error">{error}</p>}

      {binProgress != null && (
        <div className="source-info">
          <p>正在下载 llama-server 运行环境：{binProgress}%</p>
          <div className="progress-bar">
            <div style={{ width: `${binProgress}%` }} />
          </div>
        </div>
      )}

      <div className="source-list">
        {models.map(m => {
          const pct = progress[m.id];
          const isBusy = !!busy[m.id];
          return (
            <div key={m.id} className="source-card">
              <div className="source-info" style={{ border: 'none', margin: 0, padding: 0 }}>
                <h3>
                  {m.name}
                  {m.running && <span className="badge-on">运行中 · :{m.port}</span>}
                  {!m.running && m.downloaded && <span className="badge-off">已下载</span>}
                </h3>
                <p className="source-url">{m.desc} · {m.sizeMB}MB</p>
                {pct != null && (
                  <div className="progress-bar" style={{ marginTop: 8 }}>
                    <div style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <div className="source-actions" style={{ display: 'flex', gap: 8 }}>
                {!m.downloaded && (
                  <button
                    className="btn-primary small"
                    disabled={isBusy}
                    onClick={() => handleDownload(m.id)}
                  >
                    {isBusy ? `下载中 ${pct ?? 0}%` : '下载'}
                  </button>
                )}
                {m.downloaded && !m.running && (
                  <button
                    className="btn-primary small"
                    disabled={isBusy}
                    onClick={() => handleStart(m.id)}
                  >
                    {isBusy ? '启动中…' : '启动'}
                  </button>
                )}
                {m.running && (
                  <button className="btn-secondary small" onClick={() => handleStop(m.id)}>
                    停止
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {models.length === 0 && (
        <div className="empty-state small">
          <p>正在连接主进程…</p>
        </div>
      )}
    </div>
  );
}
