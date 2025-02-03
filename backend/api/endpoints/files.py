import glob
from ..database.TableStates import *
from .Endpoint import Endpoint


# Returns possible p4info and bmv2 files in the folder for initializing
class FileNames(Endpoint):
    def get(self):

        # Root dir for file locations
        # TODO: move this to a configuration file!
        p4_dir = "/p4/"
        
        p4info_files = glob.glob(p4_dir + '**/*.txt', recursive=True)
        json_files = glob.glob(p4_dir + '**/*.json', recursive=True)
                
        # Filter out topology.json
        json_files = list(filter(lambda f: "topology.json" not in f, json_files))
        
        # Remove the preceeding /p4/ from the path
        #p4info_files = list(map(lambda f: re.sub(r"^/p4/", "", f), p4info_files))
        #json_files = list(map(lambda f: re.sub(r"^/p4/", "", f), json_files))
        
        file_dict = {
            "p4_info": p4info_files,
            "bmv2": json_files
        }
        return file_dict
