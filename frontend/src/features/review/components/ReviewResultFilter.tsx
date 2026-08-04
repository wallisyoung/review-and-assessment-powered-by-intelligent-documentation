/**
 * Review result filtering component
 */
import { useTranslation } from "react-i18next";
import SegmentedControl from "../../../components/SegmentedControl";
import { HiCheck, HiX, HiViewList, HiExclamation } from "react-icons/hi";
import { FilterType } from "../hooks/useReviewResultQueries";

interface ReviewResultFilterProps {
  filter: FilterType;
  onChange: (filter: FilterType) => void;
}

export default function ReviewResultFilter({
  filter,
  onChange,
}: ReviewResultFilterProps) {
  const { t } = useTranslation();

  const filterLabels: Record<FilterType, string> = {
    all: t("review.filterAll", "All"),
    fail: t("review.fail"),
    pass: t("review.pass"),
    undeterminable: t("review.undeterminable", "判定不能"),
    processing: t("status.processing"),
  };

  const options = [
    {
      value: "all" as FilterType,
      label: filterLabels["all"],
      icon: <HiViewList className="h-4 w-4 text-aws-font-color-gray" />,
    },
    {
      value: "fail" as FilterType,
      label: filterLabels["fail"],
      icon: <HiX className="h-4 w-4 text-red" />,
    },
    {
      value: "pass" as FilterType,
      label: filterLabels["pass"],
      icon: <HiCheck className="h-4 w-4 text-green-500" />,
    },
    {
      value: "undeterminable" as FilterType,
      label: filterLabels["undeterminable"],
      icon: <HiExclamation className="text-yellow-500 h-4 w-4" />,
    },
  ];

  return (
    <SegmentedControl
      options={options}
      value={filter}
      onChange={(value) => onChange(value as FilterType)}
      name="result-filter"
      className="mb-4"
    />
  );
}
