import React, { useState } from 'react'

import { decodingInput } from '../Helpers/Decoding/DecodingInput';

function DecodingOptions({ tableInfo, tableName, decoding, setDecoding }) {
  
  const [selectedAction, setSelectedAction] = useState(null);

  const matchHandler = (event, match_key) => {
    const newDecoding = { ...decoding };
    newDecoding[tableName].match[match_key] = event.target.value;
    setDecoding(newDecoding);
  };

  const actionNameHandler = (event) => {
    setSelectedAction(event.target.value);
  }

  const actionParamsHandler = (event, param_name) => {
    const newDecoding = { ...decoding };
    newDecoding[tableName].action[selectedAction][param_name] = event.target.value;
    setDecoding(newDecoding);
  };

  return (
    decodingInput(tableInfo, tableName, decoding, matchHandler, selectedAction, actionNameHandler, actionParamsHandler)
  )
}

export default DecodingOptions