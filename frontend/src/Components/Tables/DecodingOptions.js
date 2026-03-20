import { useEffect, useState } from 'react'

import { decodingInput } from '../Helpers/Decoding/DecodingInput';

function createDefaultTableDecoding(tableInfo, tableName) {
  const currentTableInfo = tableInfo?.[tableName];

  if (!currentTableInfo) {
    return {
      match: {},
      action: {},
    };
  }

  const match = Object.keys(currentTableInfo.match_fields || {}).reduce((acc, matchKey) => {
    acc[matchKey] = "numeric";
    return acc;
  }, {});

  const action = Object.entries(currentTableInfo.actions || {}).reduce((acc, [actionName, actionData]) => {
    acc[actionName] = {};
    (actionData.params || []).forEach((param) => {
      acc[actionName][param.name] = "numeric";
    });
    return acc;
  }, {});

  return { match, action };
}

function ensureTableDecoding(decoding, tableInfo, tableName) {
  const nextDecoding = decoding ? { ...decoding } : {};

  if (nextDecoding[tableName] === undefined || nextDecoding[tableName] === null) {
    nextDecoding[tableName] = createDefaultTableDecoding(tableInfo, tableName);
  }

  return nextDecoding;
}

function DecodingOptions({ tableInfo, tableName, decoding, setDecoding }) {
  const [selectedAction, setSelectedAction] = useState(null);
  const tableDecoding = decoding?.[tableName] ?? createDefaultTableDecoding(tableInfo, tableName);

  useEffect(() => {
    setSelectedAction(null);
  }, [tableName]);

  if (!tableInfo?.[tableName]) {
    return null;
  }

  const matchHandler = (event, match_key) => {
    setDecoding((prevDecoding) => {
      const nextDecoding = ensureTableDecoding(prevDecoding, tableInfo, tableName);
      const previousTableDecoding = nextDecoding[tableName];

      nextDecoding[tableName] = {
        ...previousTableDecoding,
        match: {
          ...previousTableDecoding.match,
          [match_key]: event.target.value,
        },
      };

      return nextDecoding;
    });
  };

  const actionNameHandler = (event) => {
    setSelectedAction(event.target.value);
  }

  const actionParamsHandler = (event, param_name) => {
    setDecoding((prevDecoding) => {
      const nextDecoding = ensureTableDecoding(prevDecoding, tableInfo, tableName);
      const previousTableDecoding = nextDecoding[tableName];
      const previousActionDecoding = previousTableDecoding.action?.[selectedAction] ?? {};

      nextDecoding[tableName] = {
        ...previousTableDecoding,
        action: {
          ...previousTableDecoding.action,
          [selectedAction]: {
            ...previousActionDecoding,
            [param_name]: event.target.value,
          },
        },
      };

      return nextDecoding;
    });
  };

  return (
    decodingInput(tableInfo, tableName, tableDecoding, matchHandler, selectedAction, actionNameHandler, actionParamsHandler)
  )
}

export default DecodingOptions
