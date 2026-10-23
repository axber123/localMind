import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CheckCircle2, Circle, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Task, TaskInput, TaskPriority } from '../../../../shared/types'
import { errorText, unwrap } from '../../lib/api'
import { formatDate } from '../../lib/format'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  useToast
} from '../../components/ui'

const EMPTY: TaskInput = { title: '', description: '', priority: 'medium', dueDate: null }
const PRIORITY_LABEL: Record<TaskPriority, string> = { high: '高', medium: '中', low: '低' }

export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [filter, setFilter] = useState<'all' | 'open' | 'completed'>('open')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [form, setForm] = useState<TaskInput>(EMPTY)
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null)

  const tasks = useQuery({ queryKey: ['tasks', filter], queryFn: () => unwrap(window.localMind.tasks.list(filter)) })

  useEffect(() => {
    if (params.get('new') === '1') {
      openCreate()
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  function openCreate(): void {
    setEditing(null)
    setForm(EMPTY)
    setModal(true)
  }

  function openEdit(task: Task): void {
    setEditing(task)
    setForm({
      title: task.title,
      description: task.description ?? '',
      priority: task.priority,
      dueDate: task.dueDate,
      completed: task.completed
    })
    setModal(true)
  }

  const save = async (): Promise<void> => {
    try {
      if (editing) await unwrap(window.localMind.tasks.update(editing.id, form))
      else await unwrap(window.localMind.tasks.create(form))
      setModal(false)
      toast.success(editing ? '任务已更新' : '任务已创建')
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    } catch (error) {
      toast.error('保存失败', errorText(error))
    }
  }

  const toggle = async (task: Task): Promise<void> => {
    try {
      await unwrap(window.localMind.tasks.toggle(task.id, !task.completed))
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    } catch (error) {
      toast.error('更新失败', errorText(error))
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return
    try {
      await unwrap(window.localMind.tasks.remove(deleteTarget.id))
      setDeleteTarget(null)
      toast.success('任务已删除')
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    } catch (error) {
      toast.error('删除失败', errorText(error))
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="学习计划"
        description="把阶段目标拆成可完成的小任务。第一版提供轻量任务管理，不做复杂日历。"
        actions={<Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>新建任务</Button>}
      />
      <div className="segmented segmented--wide">
        {(['open', 'all', 'completed'] as const).map((value) => (
          <button key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
            {value === 'open' ? '待完成' : value === 'all' ? '全部' : '已完成'}
          </button>
        ))}
      </div>

      {tasks.isLoading && <Spinner label="加载任务…" />}
      {tasks.isError && <ErrorState message={errorText(tasks.error)} retry={() => void tasks.refetch()} />}
      {tasks.data?.length === 0 && (
        <EmptyState
          icon={<ListTodo size={22} />}
          title={filter === 'completed' ? '还没有完成的任务' : '学习计划还是空的'}
          description="添加一个具体、可完成的小任务，例如“读完闭包章节并写三条笔记”。"
          action={<Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>创建第一个任务</Button>}
        />
      )}

      <div className="task-list">
        {tasks.data?.map((task) => (
          <article key={task.id} className={`task-card ${task.completed ? 'task-card--done' : ''}`}>
            <button type="button" className="task-check" onClick={() => void toggle(task)} aria-label={task.completed ? '标记未完成' : '标记完成'}>
              {task.completed ? <CheckCircle2 size={20} /> : <Circle size={20} />}
            </button>
            <div className="task-card__body">
              <div className="task-card__title">
                <h3>{task.title}</h3>
                <Badge tone={task.priority === 'high' ? 'danger' : task.priority === 'medium' ? 'info' : 'neutral'}>{PRIORITY_LABEL[task.priority]}优先级</Badge>
              </div>
              {task.description && <p>{task.description}</p>}
              <div className="task-card__meta">
                {task.dueDate && <span><CalendarDays size={13} /> {task.dueDate}</span>}
                <span>创建于 {formatDate(task.createdAt)}</span>
              </div>
            </div>
            <div className="task-card__actions">
              <IconButton label="编辑任务" onClick={() => openEdit(task)}><Pencil size={14} /></IconButton>
              <IconButton label="删除任务" onClick={() => setDeleteTarget(task)}><Trash2 size={14} /></IconButton>
            </div>
          </article>
        ))}
      </div>

      <Modal open={modal} title={editing ? '编辑学习任务' : '新建学习任务'} onClose={() => setModal(false)}>
        <div className="form-grid">
          <Field label="任务标题"><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如 完成闭包练习" /></Field>
          <Field label="描述"><Textarea rows={3} value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          <div className="form-row">
            <Field label="优先级">
              <Select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as TaskPriority })}>
                <option value="high">高</option><option value="medium">中</option><option value="low">低</option>
              </Select>
            </Field>
            <Field label="截止日期">
              <Input type="date" value={form.dueDate ?? ''} onChange={(event) => setForm({ ...form, dueDate: event.target.value || null })} />
            </Field>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={Boolean(form.completed)} onChange={(event) => setForm({ ...form, completed: event.target.checked })} />
            标记为已完成
          </label>
        </div>
        <div className="modal__actions">
          <Button onClick={() => setModal(false)}>取消</Button>
          <Button variant="primary" disabled={!form.title.trim()} onClick={() => void save()}>保存</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除任务？"
        description={<p>「{deleteTarget?.title}」会从学习计划中移除。</p>}
        confirmLabel="删除"
        danger
        onConfirm={() => void remove()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  )
}
