import React from 'react';
import { Select } from '@grafana/ui';

const PRESET_INTERVALS = ['1m', '5m', '15m', '1h', '6h', '1d'];

interface Props {
  value?: string;
  onChange: (interval: string) => void;
  ariaLabel?: string;
}

export function IntervalPicker({ value, onChange, ariaLabel = 'Interval' }: Props) {
  const options = PRESET_INTERVALS.map((interval) => ({ label: interval, value: interval }));

  return (
    <Select<string>
      aria-label={ariaLabel}
      options={options}
      value={value ? { label: value, value } : undefined}
      onChange={(item) => onChange(item?.value ?? '')}
      placeholder="Type or select interval (e.g. 5m, 90s)"
      allowCustomValue
      createOptionPosition="first"
      onCreateOption={(interval) => onChange(interval)}
      formatCreateLabel={(input) => input}
      isClearable
      menuShouldPortal={false}
      width={24}
    />
  );
}
