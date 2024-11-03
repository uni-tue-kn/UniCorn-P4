import { IPv4 } from "ip-num/IPNumber";
import { IPv6 } from "ip-num/IPNumber";

// Decoding Functions (number -> x)
// -----------------------------------------
function numberToBinary(number) {
  return number.toString(2);
}

function numberToHex(number) {
  return number.toString(16);
}

function numberToIPv4(number) {
  try {
    return IPv4.fromNumber(number).toString();
  } catch (error) {
    return number;
  }
}

function numberToIPv6(number) {
  try {
    return IPv6.fromBigInt(number).toString();
  } catch (error) {
    return number;
  }
}

// Based on https://stackoverflow.com/questions/17933471/convert-integer-mac-address-to-string-in-javascript
function numberToMac(number) {
  var hexNumber = number.toString(16).padStart(12, '0')
  var macAddress = hexNumber.match(/.{2}/g).map(byte => byte.toUpperCase()).join(':');
  return macAddress
}

function decode(value, decodingType) {
  switch (decodingType) {
    case "binary":
      return numberToBinary(value);
    case "hexadecimal":
      return numberToHex(value)
    case "ipv4":
      return numberToIPv4(value);
    case "ipv6":
      return numberToIPv6(value);
    case "mac":
      return numberToMac(value);
    default:
      return value;
  }
}

export function decodeTableEntries(tableEntries, decoding, tableInfo, tableName) {
  if (tableEntries != undefined) {
    const tableDecoding = decoding[tableName];
    {
      (tableEntries).forEach(entry => {
        const switch_entry = entry.switch_entry;

        //Decode match values
        Object.entries(switch_entry.match_fields).forEach(([key, value]) => {
          const match_type = tableInfo[tableName].match_fields[key].match_type;
          switch (match_type) {
            case 1:
            case 2:
              switch_entry.match_fields[key] = decode(value, tableDecoding.match[key]);
              break;
            case 3:
              switch_entry.match_fields[key][0] = decode(value[0], tableDecoding.match[key]);
              break;
            case 4:
            case 5:
              switch_entry.match_fields[key][0] = decode(value[0], tableDecoding.match[key]);
              switch_entry.match_fields[key][1] = decode(value[1], tableDecoding.match[key]);
              break;
          }
        });

        //Decode action values
        if (switch_entry.action_params != null) {
          Object.entries(switch_entry.action_params).forEach(([param, value]) => {
            // Default to numerical decoding if there is no decode entry present
            switch_entry.action_params[param] = decode(value, (tableDecoding.action[switch_entry.action_name]?.[param]) ?? "");
          });
        }

      }
      )
    }
    return tableEntries;
  }
}


// Encoding Functions (x -> number)
// -----------------------------------------
function binaryToNumber(bitstring) {
  return parseInt(bitstring, 2);
}

function hexToNumber(hexstring) {
  return parseInt(hexstring, 16);
}

function toNumber(string, decoding) {
  if (decoding == "binary") {
    console.log(string);
    console.log(binaryToNumber(string));
    return binaryToNumber(string);
  }
  else {
    return hexToNumber(string);
  }
}

// Backend should only get integers in the request bodies
export function encodeNumerics(switch_entry, decoding, tableInfo, tableName) {
  const tableDecoding = decoding[tableName];
  let encoded_entry = switch_entry;

  //Encode match values
  Object.entries(switch_entry.match_fields).forEach(([key, value]) => {
    let keyDecoding = tableDecoding.match[key];
    if (keyDecoding == "binary" || keyDecoding == "hexadecimal") {
      const match_type = tableInfo[tableName].match_fields[key].match_type;
      switch (match_type) {
        case 1:
        case 2:
          encoded_entry.match_fields[key] = toNumber(value, keyDecoding);
          break;
        case 3:
          encoded_entry.match_fields[key][0] = toNumber(value[0], keyDecoding);
          break;
        case 4:
        case 5:
          encoded_entry.match_fields[key][0] = toNumber(value[0], keyDecoding);
          encoded_entry.match_fields[key][1] = toNumber(value[1], keyDecoding);
          break;
      }
    }
  });

  //Encode action values
  if (switch_entry.action_params != null) {
    Object.entries(switch_entry.action_params).forEach(([param, value]) => {
      let paramDecoding = tableDecoding.action[encoded_entry.action_name][param];
      if (paramDecoding == "binary" || paramDecoding == "hexadecimal") {
        encoded_entry.action_params[param] = toNumber(value, paramDecoding);
      }
    });
  }
  return encoded_entry
}

export function encodeNumericsArray(entry_array, decoding, tableInfo, tableName) {
  const encoded_entry_array = [...entry_array]
  encoded_entry_array.forEach(entry => {
    entry.switch_entry = encodeNumerics(entry.switch_entry, decoding, tableInfo, tableName);
  });
  return encoded_entry_array;
}


