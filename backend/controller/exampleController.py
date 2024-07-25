import os
import sys

# Import P4Runtime lib from parent utils dir
# Probably there's a better way of doing this.
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "utils/"))
import bmv2

from controller import Controller

exampleController = Controller()