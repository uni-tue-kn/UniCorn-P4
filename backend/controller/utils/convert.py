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

mac_pattern = re.compile(r'^(?:[0-9a-fA-F]:?){12}$')
ipv4_pattern = re.compile(r'''
    ^
    (?:
      (25[0-5]|      # 250–255
       2[0-4][0-9]|  # 200–249
       1[0-9]{2}|    # 100–199
       [1-9]?[0-9])  # 0–99
      \.
    ){3}
    (25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])
    $
''', re.VERBOSE)

def matchesMac(mac_addr_string):
    return mac_pattern.match(mac_addr_string) is not None


def encodeMac(mac_addr_string):
    return bytes.fromhex(mac_addr_string.replace(":", ""))


def decodeMac(encoded_mac_addr):
    # edited:
    # did not work properly (maybe python 2/3 clash)
    return ":".join(hex(s)[2:] for s in encoded_mac_addr)


def matchesIPv4(ip_addr_string):
    return ipv4_pattern.match(ip_addr_string) is not None  


def encodeIPv4(ip_addr_string):
    return socket.inet_aton(ip_addr_string)


def decodeIPv4(encoded_ip_addr):
    return socket.inet_ntoa(encoded_ip_addr)


def bitwidthToBytes(bitwidth):
    return int(math.ceil(bitwidth / 8.0))


def encodeNum(number, bitwidth):
    if isinstance(number, bool) or not isinstance(number, int) or not 0 <= number < 2**bitwidth:
        raise ValueError(f"Number must fit in unsigned bit<{bitwidth}>")
    byte_len = bitwidthToBytes(bitwidth)
    num_str = "%x" % number
    if number >= 2**bitwidth:
        raise Exception("Number, %d, does not fit in %d bits" % (number, bitwidth))
    return bytes.fromhex("0" * (byte_len * 2 - len(num_str)) + num_str)


def decodeNum(encoded_number):
    return int.from_bytes(encoded_number, "big")

def encode(x, bitwidth):
    "Tries to infer the type of `x` and encode it"

    byte_len = bitwidthToBytes(bitwidth)
    if (type(x) == list or type(x) == tuple) and len(x) == 1: 
        x = x[0]
    encoded_bytes = None
    if type(x) == str:
        if x.isascii() and x.isdecimal():
            encoded_bytes = encodeNum(int(x), bitwidth)
        elif matchesMac(x):
            encoded_bytes = encodeMac(x)
        elif matchesIPv4(x):
            encoded_bytes = encodeIPv4(x)
        elif matchesIPv6(x):
            encoded_bytes = encodeIPv6(x)    
        # edited:
        # x is a string that represents a number    
        else:
            raise ValueError("Expected a decimal integer, IP address or MAC address")
    elif type(x) == int:
        encoded_bytes = encodeNum(x, bitwidth)           
    else:
        raise ValueError("Encoding objects of %r is not supported" % type(x))
    if len(encoded_bytes) != byte_len:
        raise ValueError("Value width does not match the P4 field")
    return encoded_bytes


# Added functions for generic control plane:

def matchesIPv6(ip_addr_string):
    try:
        ipaddress.IPv6Address(ip_addr_string)
        return True
    except:
        return False

def encodeIPv6(ip_addr_string):
    return socket.inet_pton(socket.AF_INET6, ip_addr_string)
