/* SPDX-License-Identifier: MIT
 * Original fixture generator, linked only with the separate LibreDWG test tool.
 * cc -I$(brew --prefix libredwg)/include create-nested.c \
 *    -L$(brew --prefix libredwg)/lib -lredwg -o create-nested
 */
#include <stdlib.h>
#include <string.h>
#include <dwg.h>
#include <dwg_api.h>

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    Dwg_Data *doc = dwg_new_Document(R_2000, 0, 0);
    Dwg_Object_BLOCK_HEADER *model = dwg_model_space_object(doc)->tio.object->tio.BLOCK_HEADER;
    dwg_point_3d start = {0, 0, 0}, end = {1, 1, 0}, insert = {5, 0, 0};
    dwg_add_LINE(model, &start, &end);
    Dwg_Object_BLOCK_HEADER *part = dwg_add_BLOCK_HEADER(doc, "Detail");
    dwg_add_BLOCK(part, "Detail");
    dwg_add_ENDBLK(part);
    part->blkisxref = 1;
    part->is_xref_ref = 1;
    part->xref_pname = strdup("../detail.dxf");
    dwg_add_INSERT(model, &insert, "Detail", 1, 1, 1, 0);
    int result = dwg_write_file(argv[1], doc);
    dwg_free(doc);
    free(doc);
    return result;
}
