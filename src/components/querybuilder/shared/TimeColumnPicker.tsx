import React from 'react';
import { Select } from '@grafana/ui';

import type { ColumnInfo } from '../../../types';

interface Props {
  columns: ColumnInfo[];
  value?: string;
  onChange: (column: string) => void;
}

export function TimeColumnPicker({ columns, value, onChange }: Props) {
  const options = columns
    .filter((column) => column.isTimeColumn || /timestamp/i.test(column.type))
    .map((column) => ({ label: column.name, value: column.name }));

  return (
    <Select<string>
      aria-label="Time column"
      options={options}
      value={value ? { label: value, value } : undefined}
      onChange={(item) => onChange(item?.value ?? '')}
      placeholder="Select time column"
      isClearable
      menuShouldPortal={false}
      width={24}
    />
  );
}
