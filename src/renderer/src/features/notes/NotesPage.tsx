import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, FilePlus2, NotebookPen, Save, Search, Trash2 } from 'lucide-react'
import type { Note } from '../../../../shared/types'
import { unwrap, errorText, ClientError } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { useUiStore } from '../../store/ui'
import { Markdown } from '../../components/Markdown'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Input, PageHeader, Spinner, useToast } from '../../components/ui'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export function NotesPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const setAiScope = useUiStore((state) => state.setAiScope)
  const [search, setSearch] = useState('')
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null)
  const [editorId, setEditorId] = useState<number | null>(null)
  const selectedId = params.get('note') ? Number(params.get('note')) : null
  const requestedOffset = Number(params.get('offset') ?? 0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const notes = useQuery({ queryKey: ['notes', search], queryFn: () => unwrap(window.localMind.notes.list(search)) })
  const note = useQuery({
    queryKey: ['note', selectedId],
    queryFn: () => unwrap(window.localMind.notes.get(selectedId!)),
    enabled: Boolean(selectedId)
  })

  const revisionRef = useRef('')
  const contentRef = useRef('')
  const savedContentRef = useRef('')
  const savingRef = useRef(false)
  const dirtyRef = useRef(false)
  const activeIdRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!selectedId && notes.data?.[0]) setParams({ note: String(notes.data[0].id) }, { replace: true })
  }, [notes.data, selectedId, setParams])

  useEffect(() => {
    if (!note.data) return
    if (editorId === note.data.id) return
    setEditorId(note.data.id)
    activeIdRef.current = note.data.id
    setContent(note.data.content)
    contentRef.current = note.data.content
    savedContentRef.current = note.data.content
    revisionRef.current = note.data.revision
    dirtyRef.current = false
    setSaveState('saved')
  }, [note.data, editorId])

  useEffect(() => {
    if (!requestedOffset || !note.data || !textareaRef.current || editorId !== note.data.id) return
    const line = content.slice(0, requestedOffset).split('\n').length
    const textarea = textareaRef.current
    textarea.focus()
    textarea.setSelectionRange(requestedOffset, Math.min(content.length, requestedOffset + 160))
    textarea.scrollTop = Math.max(0, (line - 4) * 21)
  }, [requestedOffset, note.data, editorId, content])

  const persist = useCallback(async (): Promise<boolean> => {
    const id = activeIdRef.current
    if (!id || !dirtyRef.current) return true
    if (savingRef.current) return false
    const snapshot = contentRef.current
    savingRef.current = true
    setSaveState('saving')
    try {
      const result = await unwrap(
        window.localMind.notes.save({ id, content: snapshot, expectedRevision: revisionRef.current })
      )
      revisionRef.current = result.revision
      savedContentRef.current = snapshot
      if (contentRef.current === snapshot) {
        dirtyRef.current = false
        setSaveState('saved')
      } else {
        setSaveState('dirty')
        schedulePersist()
      }
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['note', id] })
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
      return true
    } catch (error) {
      if (error instanceof ClientError && error.code === 'NOTE_CONFLICT') {
        setSaveState('conflict')
        toast.error('保存冲突', '笔记文件已在外部被修改。为避免覆盖，请重新载入后再编辑。')
      } else {
        setSaveState('error')
        toast.error('自动保存失败', errorText(error))
      }
      return false
    } finally {
      savingRef.current = false
    }
  }, [queryClient, toast])

  const schedulePersist = useCallback((): void => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void persist()
    }, 850)
  }, [persist])

  const onChange = (value: string): void => {
    setContent(value)
    contentRef.current = value
    dirtyRef.current = value !== savedContentRef.current
    setSaveState(dirtyRef.current ? 'dirty' : 'saved')
    if (dirtyRef.current) schedulePersist()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void persist()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [persist])

  const selectNote = async (id: number): Promise<void> => {
    if (id === activeIdRef.current) return
    if (dirtyRef.current) {
      const saved = await persist()
      if (!saved && dirtyRef.current) {
        toast.error('未切换笔记', '当前笔记尚未保存，请先处理保存错误。')
        return
      }
    }
    setEditorId(null)
    setParams({ note: String(id) })
  }

  const create = async (): Promise<void> => {
    try {
      if (dirtyRef.current) {
        const saved = await persist()
        if (!saved) return
      }
      const created = await unwrap(window.localMind.notes.create({}))
      setEditorId(null)
      await queryClient.invalidateQueries({ queryKey: ['notes'] })
      setParams({ note: String(created.id) })
      toast.success('已创建笔记')
    } catch (error) {
      toast.error('创建笔记失败', errorText(error))
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await unwrap(window.localMind.notes.remove(deleteTarget.id))
      setDeleteTarget(null)
      setEditorId(null)
      setParams({}, { replace: true })
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      toast.success('笔记已移入回收站')
    } catch (error) {
      toast.error('删除笔记失败', errorText(error))
    }
  }

  const statusCopy: Record<SaveState, string> = {
    saved: '已保存',
    dirty: '未保存',
    saving: '保存中…',
    error: '保存失败',
    conflict: '存在冲突'
  }

  return (
    <div className="page page--notes">
      <PageHeader
        title="我的笔记"
        description="Markdown 正文保存在本地文件中，SQLite 只保存元数据。编辑会自动保存，并可在保存后重建知识库索引。"
        actions={<Button variant="primary" icon={<FilePlus2 size={15} />} onClick={() => void create()}>新建笔记</Button>}
      />
      <div className="notes-layout">
        <aside className="notes-list">
          <div className="toolbar__search">
            <Search size={15} />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索笔记标题或内容" />
          </div>
          {notes.isLoading && <Spinner label="加载笔记…" />}
          {notes.isError && <ErrorState message={errorText(notes.error)} retry={() => void notes.refetch()} />}
          {notes.data?.length === 0 && <div className="soft-empty">暂无笔记。点击右上角开始写第一篇。</div>}
          <div className="notes-list__items">
            {notes.data?.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`note-list-item ${selectedId === item.id ? 'active' : ''}`}
                onClick={() => void selectNote(item.id)}
              >
                <NotebookPen size={15} />
                <span><strong>{item.title}</strong><small>{formatRelative(item.updatedAt)}</small></span>
                <Badge tone={item.indexingStatus === 'indexed' ? 'success' : item.indexingStatus === 'failed' ? 'danger' : 'neutral'}>
                  {item.indexingStatus === 'indexed' ? '已索引' : item.indexingStatus === 'failed' ? '失败' : '待索引'}
                </Badge>
              </button>
            ))}
          </div>
        </aside>

        <section className="note-editor">
          {!selectedId && (
            <EmptyState icon={<NotebookPen size={22} />} title="选择或新建一篇笔记" description="在左侧选择笔记，或创建一个新的 Markdown 文件。" action={<Button variant="primary" onClick={() => void create()}>新建笔记</Button>} />
          )}
          {selectedId && note.isLoading && <Spinner label="打开笔记…" />}
          {selectedId && note.isError && <ErrorState message={errorText(note.error)} retry={() => void note.refetch()} />}
          {selectedId && note.data && (
            <>
              <div className="note-toolbar">
                <div>
                  <h2>{note.data.title}</h2>
                  <span className={`save-state save-state--${saveState}`}>{statusCopy[saveState]}</span>
                </div>
                <div className="note-toolbar__actions">
                  <Badge tone={note.data.indexingStatus === 'indexed' ? 'success' : note.data.indexingStatus === 'failed' ? 'danger' : 'neutral'}>
                    {note.data.indexingStatus === 'indexed' ? '知识库已更新' : note.data.indexingStatus === 'failed' ? '索引失败' : '待重建索引'}
                  </Badge>
                  <Button size="sm" icon={<Save size={13} />} loading={saveState === 'saving'} onClick={() => void persist()}>保存</Button>
                  <Button size="sm" variant="ghost" icon={<Bot size={13} />} onClick={() => setAiScope(note.data?.documentId ? { documentIds: [note.data.documentId] } : {}, note.data?.title)}>问 AI</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(note.data!)} icon={<Trash2 size={13} />}>删除</Button>
                </div>
              </div>
              {saveState === 'conflict' && (
                <div className="inline-error">
                  磁盘上的笔记文件已被外部修改。为避免覆盖，自动保存已停止。
                  <Button size="sm" onClick={() => { setEditorId(null); void note.refetch() }}>重新载入</Button>
                </div>
              )}
              {note.data.errorMessage && <div className="inline-error">索引失败：{note.data.errorMessage}</div>}
              <div className="note-split">
                <textarea
                  ref={textareaRef}
                  className="note-textarea"
                  value={content}
                  spellCheck={false}
                  onChange={(event) => onChange(event.target.value)}
                  onBlur={() => { if (dirtyRef.current) void persist() }}
                />
                <div className="note-preview">
                  <div className="note-preview__label">预览</div>
                  <Markdown content={content} />
                </div>
              </div>
            </>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这篇笔记？"
        description={<p>「{deleteTarget?.title}」的 Markdown 文件会移入系统回收站，数据库中的索引和元数据也会被清理。此操作可撤销回收站文件。</p>}
        confirmLabel="移入回收站"
        danger
        onConfirm={() => void remove()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
