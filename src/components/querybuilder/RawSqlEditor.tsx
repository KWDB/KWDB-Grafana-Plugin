import React from 'react';
import { CodeEditor } from '@grafana/ui';

import type { KwdbQuery } from '../../types';

interface Props {
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
}

export function RawSqlEditor({ query, onChange }: Props) {
  return (
    <div>
      <CodeEditor
        value={query.rawSql ?? ''}
        language="sql"
        height={220}
        showLineNumbers
        onChange={(value) => onChange({ ...query, rawSql: value, customRawSql: value })}
        onBlur={(value) => onChange({ ...query, rawSql: value, customRawSql: value })}
      />
    </div>
  );
}
