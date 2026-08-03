-- AlterTable
ALTER TABLE `check_list_sets` ADD COLUMN `declared_document_types` JSON NULL;

-- AlterTable
ALTER TABLE `check_lists` ADD COLUMN `required_document_types` JSON NULL;

-- AlterTable
ALTER TABLE `review_documents` ADD COLUMN `document_type` VARCHAR(50) NULL;

-- AlterTable
ALTER TABLE `review_jobs` ADD COLUMN `case_data` JSON NULL;
