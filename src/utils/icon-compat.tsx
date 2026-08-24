/**
 * TradeWithKen icon compatibility layer.
 *
 * The upstream D-Bot source historically exposed a string-based `Icon`
 * component (for example `IcAdd`, `IcChevronRight`, `ic-deriv`). During the
 * Quill migration the old resolver was removed and a placeholder `dummy.ts`
 * was left behind. This file is the single compatibility boundary for the
 * remaining legacy string icon names.
 *
 * New code should import concrete Quill icons directly. Keep this resolver
 * only for legacy/shared components that still receive icon names dynamically.
 */
import React from 'react';
import { AccountsDerivAccountLightIcon, LegacyWarningIcon } from '@deriv/quill-icons';
import { CurrencyEurIcon } from '@deriv/quill-icons/Currencies';
import {
    LabelPairedCheckCaptionFillIcon,
    LabelPairedChevronRightMdFillIcon,
    LabelPairedCircleExclamationCaptionFillIcon,
    LabelPairedCircleInfoCaptionRegularIcon,
    LabelPairedMinusCaptionRegularIcon,
    LabelPairedPlusCaptionRegularIcon,
} from '@deriv/quill-icons/LabelPaired';
import { TradeTypesAccumulatorStayInIcon } from '@deriv/quill-icons/TradeTypes';

type IconProps = {
    className?: string;
    color?: string;
    custom_color?: string;
    data_testid?: string;
    description?: string;
    height?: number | string;
    icon: string;
    id?: string;
    onClick?: React.MouseEventHandler<SVGSVGElement>;
    onMouseDown?: React.MouseEventHandler<SVGSVGElement>;
    onMouseEnter?: React.MouseEventHandler<SVGSVGElement>;
    onMouseLeave?: React.MouseEventHandler<SVGSVGElement>;
    onTouchStart?: React.TouchEventHandler<SVGSVGElement>;
    size?: number | string;
    style?: React.CSSProperties;
    width?: number | string;
};

const colorMap: Record<string, string> = {
    active: 'var(--text-active)',
    black: 'var(--text-general)',
    disabled: 'var(--text-disabled)',
    danger: 'var(--status-danger)',
    error: 'var(--status-danger)',
    warning: 'var(--status-warning)',
    info: 'var(--status-info)',
    general: 'var(--text-general)',
};

const getFill = (color?: string, customColor?: string) =>
    customColor || (color ? colorMap[color] || color : undefined);

const getDimension = (value: number | string | undefined, fallback: number) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return fallback;
};

const getSize = (size?: number | string) => {
    if (typeof size === 'number') return size;
    if (typeof size === 'string') {
        const named: Record<string, number> = { xs: 16, sm: 20, md: 24, lg: 32, xl: 40 };
        if (named[size]) return named[size];
        const numeric = Number(size);
        if (Number.isFinite(numeric)) return numeric;
    }
    return 24;
};

const commonProps = (props: IconProps) => {
    const size = getSize(props.size);
    return {
        className: props.className,
        'data-testid': props.data_testid,
        fill: getFill(props.color, props.custom_color),
        height: props.height ?? size,
        id: props.id,
        onClick: props.onClick,
        onMouseDown: props.onMouseDown,
        onMouseEnter: props.onMouseEnter,
        onMouseLeave: props.onMouseLeave,
        onTouchStart: props.onTouchStart,
        style: props.style,
        width: props.width ?? size,
        'aria-label': props.description,
    };
};

/**
 * Small deterministic SVG fallbacks for legacy illustration names that do
 * not have a one-to-one Quill export. They keep the UI functional without
 * reintroducing the removed icon package.
 */
const LegacyIllustration = ({
    kind,
    props,
}: {
    kind: 'migrate' | 'blockly';
    props: IconProps;
}) => {
    const size = getSize(props.size);
    const stroke = getFill(props.color, props.custom_color) || 'currentColor';
    const svgProps = {
        ...commonProps(props),
        height: props.height ?? size,
        width: props.width ?? size,
        viewBox: '0 0 48 48',
        fill: 'none',
        role: props.description ? 'img' : undefined,
    };

    if (kind === 'migrate') {
        return (
            <svg {...svgProps}>
                <rect x='7' y='9' width='13' height='13' rx='3' stroke={stroke} strokeWidth='3' />
                <rect x='28' y='26' width='13' height='13' rx='3' stroke={stroke} strokeWidth='3' />
                <path d='M20 16h8a7 7 0 0 1 7 7v3' stroke={stroke} strokeWidth='3' strokeLinecap='round' />
                <path d='m31 22 4 4 4-4' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
                <path d='M28 32h-8a7 7 0 0 1-7-7v-3' stroke={stroke} strokeWidth='3' strokeLinecap='round' />
                <path d='m17 26-4-4-4 4' stroke={stroke} strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
        );
    }

    return (
        <svg {...svgProps}>
            <rect x='7' y='7' width='14' height='14' rx='3' stroke={stroke} strokeWidth='3' />
            <rect x='27' y='7' width='14' height='14' rx='3' stroke={stroke} strokeWidth='3' />
            <rect x='7' y='27' width='14' height='14' rx='3' stroke={stroke} strokeWidth='3' />
            <path d='M27 34h14' stroke={stroke} strokeWidth='3' strokeLinecap='round' />
            <path d='M34 27v14' stroke={stroke} strokeWidth='3' strokeLinecap='round' />
        </svg>
    );
};

export const Icon = (props: IconProps) => {
    const { icon } = props;
    const p = commonProps(props);

    switch (icon) {
        case 'IcAdd':
        case 'IcAddBold':
            return <LabelPairedPlusCaptionRegularIcon {...p} />;

        case 'IcMinus':
            return <LabelPairedMinusCaptionRegularIcon {...p} />;

        case 'IcCheckmark':
            return <LabelPairedCheckCaptionFillIcon {...p} />;

        case 'IcChevronRight':
        case 'IcChevronRightBold':
            return <LabelPairedChevronRightMdFillIcon {...p} />;

        case 'IcCircle':
            return (
                <span
                    className={props.className}
                    data-testid={props.data_testid}
                    id={props.id}
                    onClick={props.onClick}
                    style={{
                        ...props.style,
                        backgroundColor: getFill(props.color, props.custom_color) || 'currentColor',
                        borderRadius: '50%',
                        display: 'inline-block',
                        height: props.height ?? getSize(props.size),
                        width: props.width ?? getSize(props.size),
                    }}
                    aria-label={props.description}
                />
            );

        case 'IcUnknown':
        case 'IcAlertInfo':
            return <LabelPairedCircleInfoCaptionRegularIcon {...p} />;

        case 'IcAlertDanger':
            return <LabelPairedCircleExclamationCaptionFillIcon {...p} />;

        case 'IcAlertWarning':
            return <LegacyWarningIcon {...p} />;

        case 'ic-deriv':
            return <AccountsDerivAccountLightIcon {...p} />;

        case 'ic-currency-eur-check':
            return <CurrencyEurIcon {...p} />;

        case 'IcTradetypeAccu':
            return <TradeTypesAccumulatorStayInIcon {...p} />;

        case 'IcMigrateStrategy':
            return <LegacyIllustration kind='migrate' props={props} />;

        case 'IcUpgradeBlockly':
            return <LegacyIllustration kind='blockly' props={props} />;

        default:
            // Legacy tabs/selects can still pass an icon name from configuration.
            // A visible, accessible fallback is preferable to a runtime crash or
            // an empty slot. Unknown names should be migrated to a concrete
            // Quill icon when their source is touched.
            return <LabelPairedCircleInfoCaptionRegularIcon {...p} />;
    }
};

export default Icon;
