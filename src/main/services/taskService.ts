import type { AppDatabase } from '../db/database'
import { AppError, nowIso } from '../db/database'
import type { Task, TaskInput } from '../../shared/types'

interface TaskRow {
  id: number
  title: string
  description: string | null
  priority: Task['priority']
  due_date: string | null
  completed: number
  created_at: string
  updated_at: string
}

export class TaskService {
  constructor(private readonly db: AppDatabase) {}

  private map(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      priority: row.priority,
      dueDate: row.due_date,
      completed: row.completed === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  list(filter: 'all' | 'open' | 'completed'): Task[] {
    const where = filter === 'open' ? 'WHERE completed = 0' : filter === 'completed' ? 'WHERE completed = 1' : ''
    return this.db
      .all<TaskRow>(
        `SELECT * FROM tasks ${where}
         ORDER BY completed ASC,
                  CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                  due_date IS NULL, due_date ASC, created_at DESC`
      )
      .map((row) => this.map(row))
  }

  create(input: TaskInput): Task {
    const now = nowIso()
    const result = this.db.run(
      `INSERT INTO tasks(title, description, priority, due_date, completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.title.trim(),
      input.description?.trim() || null,
      input.priority,
      input.dueDate || null,
      input.completed ? 1 : 0,
      now,
      now
    )
    return this.get(result.lastInsertRowid)
  }

  update(id: number, input: TaskInput): Task {
    const result = this.db.run(
      `UPDATE tasks SET title = ?, description = ?, priority = ?, due_date = ?, completed = ?, updated_at = ?
       WHERE id = ?`,
      input.title.trim(),
      input.description?.trim() || null,
      input.priority,
      input.dueDate || null,
      input.completed ? 1 : 0,
      nowIso(),
      id
    )
    if (result.changes === 0) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被删除。')
    return this.get(id)
  }

  toggle(id: number, completed: boolean): Task {
    const result = this.db.run('UPDATE tasks SET completed = ?, updated_at = ? WHERE id = ?', completed ? 1 : 0, nowIso(), id)
    if (result.changes === 0) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被删除。')
    return this.get(id)
  }

  remove(id: number): void {
    const result = this.db.run('DELETE FROM tasks WHERE id = ?', id)
    if (result.changes === 0) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被删除。')
  }

  private get(id: number): Task {
    const row = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id)
    if (!row) throw new AppError('TASK_NOT_FOUND', '任务不存在或已被删除。')
    return this.map(row)
  }
}
