/**
 * Small shared UI primitives (dark theme, Tailwind).
 * Colors come from the @theme tokens in index.css (accent, surface, line…).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useI18n } from '../i18n/index.js';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`rounded-xl border border-line bg-surface/60 ${className}`}>
            {children}
        </div>
    );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
    return (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">{children}</h2>
            {right}
        </div>
    );
}

export type BadgeTone = 'zinc' | 'green' | 'orange' | 'red' | 'blue' | 'purple';

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: BadgeTone }) {
    const tones: Record<BadgeTone, string> = {
        zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
        green: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
        orange: 'bg-accent/10 text-accent-soft border-accent/30',
        red: 'bg-red-500/10 text-red-400 border-red-500/30',
        blue: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
        purple: 'bg-violet-500/10 text-violet-400 border-violet-500/30'
    };
    return (
        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
            {children}
        </span>
    );
}

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-zinc-950 hover:bg-accent-soft disabled:bg-zinc-700 disabled:text-zinc-500',
    ghost: 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40',
    danger: 'border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-40'
};

interface ButtonProps extends Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'title' | 'type' | 'autoFocus'> {
    children: ReactNode;
    variant?: ButtonVariant;
    disabled?: boolean;
    small?: boolean;
    /** Shows a spinner instead of the content and blocks clicks. */
    loading?: boolean;
}

export function Button({ children, onClick, variant = 'primary', disabled = false, small = false, loading = false, title, type, autoFocus }: ButtonProps) {
    return (
        <button
            type={type}
            title={title}
            autoFocus={autoFocus}
            disabled={disabled || loading}
            onClick={onClick}
            className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${small ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'} ${buttonVariants[variant]}`}
        >
            {loading ? <Spinner size={small ? 12 : 14} /> : children}
        </button>
    );
}

/** Icon-only square button; pass a single icon as child and an accessible title. */
export function IconButton({ children, onClick, variant = 'ghost', disabled = false, loading = false, title }: Omit<ButtonProps, 'small'>) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            disabled={disabled || loading}
            onClick={onClick}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed ${buttonVariants[variant]}`}
        >
            {loading ? <Spinner size={13} /> : children}
        </button>
    );
}

export type ProgressTone = 'orange' | 'green' | 'red';

export function ProgressBar({ value, tone = 'orange' }: { value: number; tone?: ProgressTone }) {
    const tones: Record<ProgressTone, string> = {
        orange: 'bg-accent',
        green: 'bg-emerald-500',
        red: 'bg-red-500'
    };
    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className={`h-full rounded-full transition-all duration-300 ${tones[tone]}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
        </div>
    );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
    return (
        <label className="flex flex-none cursor-pointer select-none items-center gap-2">
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={`relative h-5 w-9 flex-none rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
            >
                <span
                    className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                    style={{ left: checked ? '1.15rem' : '0.125rem' }}
                />
            </button>
            {label && <span className="whitespace-nowrap text-sm text-zinc-300">{label}</span>}
        </label>
    );
}

const fieldClasses = 'max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-zinc-600 focus:border-accent';

export function Input({
    value,
    onChange,
    placeholder,
    type = 'text',
    className = ''
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: string;
    className?: string;
}) {
    return (
        <input
            type={type}
            value={value}
            placeholder={placeholder}
            onChange={event => onChange(event.target.value)}
            className={`${fieldClasses} ${className}`}
        />
    );
}

export function Select({
    value,
    onChange,
    options,
    className = ''
}: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    className?: string;
}) {
    return (
        <select
            value={value}
            onChange={event => onChange(event.target.value)}
            className={`${fieldClasses} ${className}`}
        >
            {options.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
            ))}
        </select>
    );
}

/** One settings line: label + optional hint on the left, control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
                <div className="text-sm">{label}</div>
                {hint && <div className="text-xs text-zinc-500">{hint}</div>}
            </div>
            <div className="flex-none">{children}</div>
        </div>
    );
}

export function EmptyState({ title, hint, icon, children }: { title: string; hint?: string; icon?: ReactNode; children?: ReactNode }) {
    return (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-12 text-center">
            {icon && <div className="mb-3 text-zinc-600">{icon}</div>}
            <div className="text-sm font-medium text-zinc-400">{title}</div>
            {hint && <div className="mt-1 text-xs text-zinc-600">{hint}</div>}
            {children && <div className="mt-4">{children}</div>}
        </div>
    );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
    const { t } = useI18n();
    return (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">
            <span className="min-w-0 flex-1">{message}</span>
            {onRetry && <Button small variant="ghost" onClick={onRetry}>{t('ui.retry')}</Button>}
        </div>
    );
}

export function Skeleton({ className = '' }: { className?: string }) {
    return <div className={`animate-pulse rounded-lg bg-zinc-800/70 ${className}`} />;
}

export function Spinner({ size = 16 }: { size?: number }) {
    return (
        <span
            className="inline-block flex-none animate-spin rounded-full border-2 border-zinc-600 border-t-accent"
            style={{ width: size, height: size }}
        />
    );
}
