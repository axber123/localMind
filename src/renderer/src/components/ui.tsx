import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react'

export type Tone = 'neutral' | 'info' | 'success' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`button button--${variant} button--${size} ${className}`}
    >
      {loading ? <Loader2 size={16} className="spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...props} className={`icon-button ${props.className ?? ''}`} title={label} aria-label={label}>
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input select ${props.className ?? ''}`} />
}

export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={`badge badge--${tone} ${className}`}>{children}</span>
}

export function TagChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  return (
    <span className="tag" style={color ? { borderColor: `${color}55`, color } : undefined}>
      <span className="tag__dot" style={color ? { background: color } : undefined} />
      {name}
      {onRemove && (
        <button type="button" className="tag__x" onClick={onRemove} aria-label={`移除 ${name}`}>
          <X size={11} />
        </button>
      )}
    </span>
  )
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className="progress">
      <div className="progress__track">
        <div className="progress__bar" style={{ width: `${percent}%` }} />
      </div>
      {label && (
        <div className="progress__label">
          <span>{label}</span>
          <span>{percent}%</span>
        </div>
      )}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <Loader2 className="spin" size={20} />
      {label && <span>{label}</span>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon ?? <Info size={22} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ title = '加载失败', message, retry }: { title?: string; message: string; retry?: () => void }) {
  return (
    <div className="error-state">
      <AlertCircle size={22} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {retry && (
        <Button size="sm" onClick={retry}>
          重试
        </Button>
      )}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  wide
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal--wide' : ''}`}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal__panel">
        <div className="modal__head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  danger,
  onConfirm,
  onClose,
  loading
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <div className="confirm-body">{description}</div>
      <div className="modal__actions">
        <Button onClick={onClose}>取消</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}

interface ToastItem {
  id: number
  title: string
  description?: string
  tone: Tone
}

interface ToastApi {
  show: (toast: Omit<ToastItem, 'id'>) => void
  success: (title: string, description?: string) => void
  error: (title: string, description?: string) => void
  info: (title: string, description?: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const remove = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])
  const show = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      const id = nextId.current++
      setItems((current) => [...current.slice(-3), { ...toast, id }])
      window.setTimeout(() => remove(id), 4200)
    },
    [remove]
  )
  const api = useRef<ToastApi>({
    show,
    success: (title, description) => show({ title, description, tone: 'success' }),
    error: (title, description) => show({ title, description, tone: 'danger' }),
    info: (title, description) => show({ title, description, tone: 'info' })
  })
  return (
    <ToastContext.Provider value={api.current}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            <span className="toast__icon">
              {item.tone === 'success' ? <CheckCircle2 size={18} /> : item.tone === 'danger' ? <AlertCircle size={18} /> : <Info size={18} />}
            </span>
            <div>
              <strong>{item.title}</strong>
              {item.description && <p>{item.description}</p>}
            </div>
            <IconButton label="关闭提示" onClick={() => remove(item.id)}>
              <X size={14} />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}
