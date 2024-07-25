# Copyright 2017-present Open Networking Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
import math
import re
import socket
import ipaddress

"""
This package contains several helper functions for encoding to and decoding from byte strings:
- integers
- IPv4 address strings
- Ethernet address strings
"""

mac_pattern = re.compile("^([\da-fA-F]{2}:){5}([\da-fA-F]{2})$")


def matchesMac(mac_addr_string):
    return mac_pattern.match(mac_addr_string) is not None


def encodeMac(mac_addr_string):
    return bytes.fromhex(mac_addr_string.replace(":", ""))


def decodeMac(encoded_mac_addr):
    # edited:
    # did not work properly (maybe python 2/3 clash)
    return ":".join(hex(s)[2:] for s in encoded_mac_addr)


ipv4_pattern = re.compile("^(\d{1,3}\.){3}(\d{1,3})$")


def matchesIPv4(ip_addr_string):
    return ipv4_pattern.match(ip_addr_string) is not None


def encodeIPv4(ip_addr_string):
    return socket.inet_aton(ip_addr_string)


def decodeIPv4(encoded_ip_addr):
    return socket.inet_ntoa(encoded_ip_addr)


def bitwidthToBytes(bitwidth):
    return int(math.ceil(bitwidth / 8.0))


def encodeNum(number, bitwidth):
    byte_len = bitwidthToBytes(bitwidth)
    num_str = "%x" % number
    if number >= 2**bitwidth:
        raise Exception("Number, %d, does not fit in %d bits" % (number, bitwidth))
    return bytes.fromhex("0" * (byte_len * 2 - len(num_str)) + num_str)


def decodeNum(encoded_number):
    return int(encoded_number.hex(), 16)

def encode(x, bitwidth):
    "Tries to infer the type of `x` and encode it"

    byte_len = bitwidthToBytes(bitwidth)
    if (type(x) == list or type(x) == tuple) and len(x) == 1: 
        x = x[0]
    encoded_bytes = None
    if type(x) == str:
        if matchesMac(x):
            encoded_bytes = encodeMac(x)
        elif matchesIPv4(x):
            encoded_bytes = encodeIPv4(x)
        elif matchesIPv6(x):
            encoded_bytes = encodeIPv6(x)    
        # edited:
        # x is a string that represents a number    
        elif x.isnumeric():
            encoded_bytes = encodeNum(int(x), bitwidth)
        else:
            # Assume that the string is already encoded
            encoded_bytes = x
    elif type(x) == int:
        encoded_bytes = encodeNum(x, bitwidth)  
    else:
        raise Exception("Encoding objects of %r is not supported" % type(x))   
    assert len(encoded_bytes) == byte_len
    return encoded_bytes


# Added functions for generic control plane:

def matchesIPv6(ip_addr_string):
    #return ipv6_pattern.match(ip_addr_string) is not None
    try:
        ipaddress.IPv6Address(ip_addr_string)
        return True
    except:
        return False

def encodeIPv6(ip_addr_string):
    return socket.inet_pton(socket.AF_INET6, ip_addr_string)




