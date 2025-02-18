import glob
from ..database.TableStates import *
from .Endpoint import Endpoint
import os

# Returns possible .p4 source files
class P4Source(Endpoint):
    def get(self):

        # Root dir for file locations
        p4_dir = os.environ.get('P4_DIR', "/p4")
        
        p4src_files = glob.glob(p4_dir + '**/*.p4', recursive=True)
            
        
        file_dict = {
            "p4src": p4src_files,
        }
        return file_dict
