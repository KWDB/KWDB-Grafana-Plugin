import React from 'react';
import { MultiSelect, Select } from '@grafana/ui';
import type { SelectableValue } from '@grafana/data';

import type { ColumnInfo } from '../../../types';

interface Props {
  columns: ColumnInfo[];
  value: string[];
  onChange: (value: string[]) => void;
  kind?: 'tags' | 'metric';
  ariaLabel?: string;
  placeholder?: string;
  width?: number;
}

function toOption(column: ColumnInfo): SelectableValue<string> {
  return {
    label: column.isTag ? `${column.name} (tag)` : column.name,
    value: column.name,
    description: column.type || (column.isTag ? 'tag' : undefined),
  };
}

export function ColumnPicker({ columns, value, onChange, kind = 'tags', ariaLabel, placeholder, width }: Props) {
  const tagOptions = columns.filter((column) => column.isTag).map(toOption);
  const dataOptions = columns.filter((column) => !column.isTag).map(toOption);
  const optionsByValue = new Map([...tagOptions, ...dataOptions].map((option) => [option.value as string, option]));

  if (kind === 'metric') {
    return (
      <Select<string>
        aria-label={ariaLabel ?? 'Metric column'}
        options={dataOptions}
        value={value[0] ? (optionsByValue.get(value[0]) ?? { label: value[0], value: value[0] }) : undefined}
        onChange={(item) => onChange(item?.value ? [item.value] : [])}
        placeholder={placeholder ?? 'Select metric column'}
        isClearable
        menuShouldPortal={false}
        width={width ?? 20}
      />
    );
  }

  return (
    <MultiSelect<string>
      aria-label={ariaLabel ?? 'Tags'}
      options={[{ label: 'Tag columns', options: tagOptions }]}
      value={value.map((item) => optionsByValue.get(item) ?? { label: item, value: item })}
      onChange={(items) => onChange(items.map((item) => item.value).filter((item): item is string => Boolean(item)))}
      placeholder={placeholder ?? 'Select tags for GROUP BY'}
      isClearable
      menuShouldPortal={false}
      width={width ?? 40}
    />
  );
}
