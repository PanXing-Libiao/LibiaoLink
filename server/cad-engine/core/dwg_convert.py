"""Local native DWG worker entry; production upload routes remain gated.

Run with a private output directory. Source drawings are opened read-only; the
external caller must apply process/network/resource budgets to the native read.
"""
import argparse
from pathlib import Path
from unified.dwg_adapter import assemble_native, file_identity, run_reader


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--output',required=True)
    parser.add_argument('--reader')
    parser.add_argument('--dotnet')
    parser.add_argument('--assemble-only',action='store_true')
    parser.add_argument('--font-dir', help='Explicit local companion font directory; files stay local')
    args=parser.parse_args()
    source=Path(args.source).resolve()
    file_identity(source)
    output=Path(args.output).resolve()
    native=output/'native'
    if not args.assemble_only:
        if not args.reader or not args.dotnet:parser.error('--reader and --dotnet are required for the native decode')
        if native.exists():raise ValueError('Native output exists; use a new directory or explicitly reassemble retained records')
        run_reader(args.dotnet,args.reader,source,native,stdout=None)
    from unified.dwg_text import read_font_files
    print(assemble_native(native,source,output,font_files=read_font_files(args.font_dir)))


if __name__=='__main__':main()
