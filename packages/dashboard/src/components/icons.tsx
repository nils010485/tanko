/**
 * Icon set: thin wrappers around lucide-react, re-exported under the
 * historical `Icon*` names so call sites don't change. All icons accept
 * `size` (number) plus any SVG prop.
 */
import {
    Activity,
    ArrowLeft,
    ArrowLeftRight,
    Bell,
    Book,
    Bookmark,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    Ellipsis,
    Eye,
    EyeOff,
    Folder,
    Globe,
    Grid3x3,
    Import,
    LayoutGrid,
    Link2,
    List,
    ListChecks,
    type LucideProps,
    Menu,
    Pause,
    Play,
    Plus,
    RefreshCw,
    Search,
    Settings2,
    SlidersHorizontal,
    Square,
    Star,
    Trash2,
    TriangleAlert,
    Undo2,
    X
} from 'lucide-react';
import type { ReactNode } from 'react';

export type IconProps = LucideProps;

/** Covers both plain functions and lucide's callable exotic components. */
type IconComponent = (props: IconProps) => ReactNode;

/** Decorative icons: hidden from assistive tech (buttons carry titles/labels). */
function decorative(Icon: IconComponent) {
    return function DecorativeIcon(props: IconProps) {
        return <Icon aria-hidden {...props} />;
    };
}

function filled(Icon: IconComponent) {
    return function FilledIcon(props: IconProps) {
        return <Icon fill="currentColor" strokeWidth={1.5} {...props} />;
    };
}

export const IconSearch = decorative(Search);
export const IconGlobe = decorative(Globe);
export const IconSquare = decorative(Square);
export const IconLibrary = decorative(Book);
export const IconDownload = decorative(Download);
export const IconTasks = decorative(ListChecks);
export const IconBell = decorative(Bell);
export const IconArrowLeftRight = decorative(ArrowLeftRight);
export const IconActivity = decorative(Activity);
export const IconSettings = decorative(Settings2);
export const IconRefresh = decorative(RefreshCw);
export const IconCheck = decorative(Check);
export const IconX = decorative(X);
export const IconEye = decorative(Eye);
export const IconEyeOff = decorative(EyeOff);
export const IconPlus = decorative(Plus);
export const IconTrash = decorative(Trash2);
export const IconChevronDown = decorative(ChevronDown);
export const IconChevronLeft = decorative(ChevronLeft);
export const IconChevronRight = decorative(ChevronRight);
export const IconAlert = decorative(TriangleAlert);
export const IconFolder = decorative(Folder);
export const IconPause = decorative(Pause);
export const IconPlay = decorative(Play);
export const IconStar = decorative(Star);
export const IconImport = decorative(Import);
export const IconMenu = decorative(Menu);
export const IconGrid = decorative(LayoutGrid);
export const IconGridSmall = decorative(Grid3x3);
export const IconList = decorative(List);
export const IconLink = decorative(Link2);
export const IconSliders = decorative(SlidersHorizontal);
export const IconBookmark = decorative(Bookmark);
export const IconBookmarkFilled = filled(decorative(Bookmark));
export const IconUndo = decorative(Undo2);
export const IconDots = decorative(Ellipsis);
export const IconArrowLeft = decorative(ArrowLeft);

/** GitHub logo — brand icons were removed from lucide, kept local. */
export function IconGitHub({ size = 16, ...props }: IconProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            {...props}
        >
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
            <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
    );
}
